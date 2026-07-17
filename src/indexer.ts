import * as fs from "fs";
import * as path from "path";
import fg from "fast-glob";
import type { CollectionConfig } from "./config.js";
import { Classifier } from "./classifier.js";
import { type LinkRecord, type Occurrence, linkToRecord } from "./types.js";
import { parseMarkdownAST, extractWikiLinks, extractContext } from "./parser.js";

function normalize(target: string): string {
  return target.trim().toLowerCase().replace(/\s+/g, " ");
}

function sourceFolder(sourcePath: string): string {
  const parts = sourcePath.split("/");
  if (parts.length >= 2) return parts.slice(0, 2).join("/");
  return parts[0] ?? sourcePath;
}

interface VaultInfo {
  fileMtimes: Map<string, number>;
  resolvedStems: Set<string>;
}

async function walkVault(vaultRoot: string): Promise<VaultInfo> {
  const fileMtimes = new Map<string, number>();
  const resolvedStems = new Set<string>();

  const entries = await fg("**/*.md", {
    cwd: vaultRoot,
    absolute: false,
    suppressErrors: true,
    dot: false,
    stats: true,
  });

  for (const entry of entries) {
    fileMtimes.set(entry.path, entry.stats!.mtimeMs);
    resolvedStems.add(path.basename(entry.path, ".md").toLowerCase());
  }
  return { fileMtimes, resolvedStems };
}

function isResolved(
  target: string,
  resolvedStems: Set<string>,
  vaultRoot: string,
  cache: Map<string, boolean>,
): boolean {
  const cached = cache.get(target);
  if (cached !== undefined) return cached;

  const stem = path.basename(target).toLowerCase().replace(/\.md$/i, "");
  let result = resolvedStems.has(stem);
  if (!result) {
    const candidate = path.join(vaultRoot, target.endsWith(".md") ? target : target + ".md");
    result = fs.existsSync(candidate);
  }
  cache.set(target, result);
  return result;
}

function readFile(vaultRoot: string, relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(vaultRoot, relPath), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Parses a single file once and returns the occurrences of every unresolved
 * wikilink it contains, keyed by target. One AST parse per file covers both
 * target discovery and occurrence/context extraction.
 */
function scanFileForUnresolvedLinks(
  vaultRoot: string,
  relPath: string,
  resolvedStems: Set<string>,
  excludeExtensions: Set<string>,
  isResolvedCache: Map<string, boolean>,
): Map<string, Occurrence[]> {
  const results = new Map<string, Occurrence[]>();
  const text = readFile(vaultRoot, relPath);
  if (text === null) return results;

  const tree = parseMarkdownAST(text);
  for (const link of extractWikiLinks(tree, text)) {
    if (!link.target) continue;
    const ext = path.extname(link.target).toLowerCase();
    if (excludeExtensions.has(ext)) continue;
    if (isResolved(link.target, resolvedStems, vaultRoot, isResolvedCache)) continue;

    const [ctxBefore, ctxAfter] = extractContext(text, link.startOffset, link.endOffset);
    const occ: Occurrence = {
      source: relPath,
      source_folder: sourceFolder(relPath),
      line: link.line,
      alias: link.alias,
      semantic_type: link.semanticType,
      context_before: ctxBefore,
      context_after: ctxAfter,
    };
    const list = results.get(link.target) ?? [];
    list.push(occ);
    results.set(link.target, list);
  }
  return results;
}

function mergeInto(target: Map<string, Occurrence[]>, source: Map<string, Occurrence[]>): void {
  for (const [key, occs] of source) {
    const list = target.get(key) ?? [];
    list.push(...occs);
    target.set(key, list);
  }
}

interface ScanManifest {
  origin_folders: string[];
  files: Map<string, number>;
}

function loadScanManifest(p: string): ScanManifest {
  if (!fs.existsSync(p)) return { origin_folders: [], files: new Map() };
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    if ("files" in raw && typeof raw["files"] === "object" && raw["files"] !== null) {
      return {
        origin_folders: Array.isArray(raw["origin_folders"]) ? raw["origin_folders"] as string[] : [],
        files: new Map(Object.entries(raw["files"] as Record<string, number>)),
      };
    }
    return { origin_folders: [], files: new Map() };
  } catch {
    return { origin_folders: [], files: new Map() };
  }
}

function saveScanManifest(p: string, originFolders: string[], fileMtimes: Map<string, number>): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ origin_folders: originFolders, files: Object.fromEntries(fileMtimes) }));
}

function occurrenceFromRecord(o: Occurrence): Occurrence {
  return {
    source: o.source,
    source_folder: o.source_folder,
    line: o.line,
    alias: o.alias,
    semantic_type: o.semantic_type,
    context_before: o.context_before,
    context_after: o.context_after,
  };
}

/**
 * Classifies each target's occurrences into a sorted LinkRecord list.
 * `reuseClassification` lets incremental builds skip reclassifying targets
 * whose occurrences didn't change.
 */
function buildLinkRecords(
  occurrencesByTarget: Map<string, Occurrence[]>,
  classifier: Classifier,
  excludeTypes: Set<string>,
  reuseClassification?: (target: string) => ReturnType<Classifier["classify"]> | undefined,
): LinkRecord[] {
  const links: LinkRecord[] = [];
  for (const target of [...occurrencesByTarget.keys()].sort()) {
    const occs = occurrencesByTarget.get(target) ?? [];
    if (occs.length === 0) continue;
    const [cls, conf, feats] = reuseClassification?.(target) ?? classifier.classify(target, occs);
    if (excludeTypes.has(cls)) continue;
    links.push(linkToRecord({ target, normalized: normalize(target), expected_destination: cls, classification_confidence: conf, title_features: feats, occurrences: occs }));
  }
  return links;
}

async function fullBuild(
  vaultRoot: string,
  fileMtimes: Map<string, number>,
  resolvedStems: Set<string>,
  originFolders: string[],
  excludeExtensions: Set<string>,
  excludeTypes: Set<string>,
  classifier: Classifier,
  onProgress?: (done: number, total: number) => void,
): Promise<LinkRecord[]> {
  let filesToScan = [...fileMtimes.keys()];
  if (originFolders.length > 0) {
    filesToScan = filesToScan.filter((f) => originFolders.some((p) => f.startsWith(p)));
  }

  const occurrencesByTarget = new Map<string, Occurrence[]>();
  const isResolvedCache = new Map<string, boolean>();
  let i = 0;
  const total = filesToScan.length;
  for (const relPath of filesToScan) {
    ++i;
    onProgress?.(i, total);
    mergeInto(occurrencesByTarget, scanFileForUnresolvedLinks(vaultRoot, relPath, resolvedStems, excludeExtensions, isResolvedCache));
  }

  return buildLinkRecords(occurrencesByTarget, classifier, excludeTypes);
}

async function incrementalBuild(
  vaultRoot: string,
  currentFiles: Map<string, number>,
  resolvedStems: Set<string>,
  oldManifest: Map<string, number>,
  originFolders: string[],
  excludeExtensions: Set<string>,
  excludeTypes: Set<string>,
  classifier: Classifier,
  existingJsonl: string,
  onProgress?: (done: number, total: number) => void,
): Promise<LinkRecord[]> {
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const [p, mtime] of currentFiles) {
    if (!oldManifest.has(p) || oldManifest.get(p) !== mtime) changed.push(p);
  }
  for (const p of oldManifest.keys()) {
    if (!currentFiles.has(p)) deleted.push(p);
  }
  const staleSources = new Set([...changed, ...deleted]);

  if (staleSources.size === 0) {
    process.stderr.write("  index is up to date, nothing to rescan.\n");
    return readJsonl(existingJsonl);
  }
  process.stderr.write(`  ${changed.length} modified/new, ${deleted.length} deleted source files.\n`);

  const oldLinksRaw = readJsonl(existingJsonl);
  const isResolvedCache = new Map<string, boolean>();

  const occurrencesByTarget = new Map<string, Occurrence[]>();
  const oldClassification = new Map<string, ReturnType<Classifier["classify"]>>();

  for (const link of oldLinksRaw) {
    const target = link.target;
    if (isResolved(target, resolvedStems, vaultRoot, isResolvedCache)) continue;
    const kept = link.occurrences.filter((o: Occurrence) => !staleSources.has(o.source)).map(occurrenceFromRecord);
    occurrencesByTarget.set(target, kept);
    oldClassification.set(target, [link.expected_destination, link.classification_confidence, link.title_features]);
  }

  const targetsStale = new Set<string>();
  for (const link of oldLinksRaw) {
    for (const o of link.occurrences as Occurrence[]) {
      if (staleSources.has(o.source)) targetsStale.add(link.target);
    }
  }

  let filesToRescan = changed;
  if (originFolders.length > 0) {
    filesToRescan = filesToRescan.filter((f) => originFolders.some((p) => f.startsWith(p)));
  }

  let scanDone = 0;
  const scanTotal = filesToRescan.length;
  for (const relPath of filesToRescan) {
    ++scanDone;
    onProgress?.(scanDone, scanTotal);
    const fileLinks = scanFileForUnresolvedLinks(vaultRoot, relPath, resolvedStems, excludeExtensions, isResolvedCache);
    for (const target of fileLinks.keys()) targetsStale.add(target);
    mergeInto(occurrencesByTarget, fileLinks);
  }

  return buildLinkRecords(
    occurrencesByTarget,
    classifier,
    excludeTypes,
    (target) => (targetsStale.has(target) ? undefined : oldClassification.get(target)),
  );
}

export interface BuildOptions {
  existingJsonl?: string;
  scanManifestPath?: string;
  onProgress?: (done: number, total: number) => void;
}

export async function buildIndex(
  vaultRoot: string,
  config: CollectionConfig,
  classifier: Classifier,
  opts: BuildOptions = {},
): Promise<LinkRecord[]> {
  const sourceCfg = config.source;
  const classifierCfg = config.classifier;
  const originFolders = [...sourceCfg.origin_folders];
  const excludeExtensions = new Set(sourceCfg.exclude_extensions.map((e) => e.toLowerCase()));
  const excludeTypes = new Set(classifierCfg.exclude_types);

  const { fileMtimes, resolvedStems } = await walkVault(vaultRoot);

  const oldManifest = opts.scanManifestPath ? loadScanManifest(opts.scanManifestPath) : { origin_folders: [], files: new Map<string, number>() };

  const originFoldersChanged =
    JSON.stringify([...originFolders].sort()) !== JSON.stringify([...oldManifest.origin_folders].sort());

  if (originFoldersChanged && oldManifest.files.size > 0) {
    process.stderr.write("  origin_folders changed — running full rebuild.\n");
  }

  const incremental =
    !originFoldersChanged &&
    oldManifest.files.size > 0 &&
    !!opts.existingJsonl &&
    fs.existsSync(opts.existingJsonl);

  let links: LinkRecord[];
  if (incremental) {
    links = await incrementalBuild(
      vaultRoot, fileMtimes, resolvedStems, oldManifest.files,
      originFolders, excludeExtensions, excludeTypes,
      classifier, opts.existingJsonl!, opts.onProgress,
    );
  } else {
    links = await fullBuild(
      vaultRoot, fileMtimes, resolvedStems,
      originFolders, excludeExtensions, excludeTypes,
      classifier, opts.onProgress,
    );
  }

  if (opts.scanManifestPath) {
    saveScanManifest(opts.scanManifestPath, originFolders, fileMtimes);
  }
  return links;
}

export function writeJsonl(links: LinkRecord[], outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const lines = links.map((l) => JSON.stringify(l)).join("\n");
  fs.writeFileSync(outPath, lines ? lines + "\n" : "");
}

export function readJsonl(filePath: string): LinkRecord[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf-8");
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as LinkRecord);
}
