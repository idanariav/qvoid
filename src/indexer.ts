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

  const files = await fg("**/*.md", {
    cwd: vaultRoot,
    absolute: false,
    suppressErrors: true,
    dot: false,
  });

  for (const rel of files) {
    const abs = path.join(vaultRoot, rel);
    try {
      const stat = fs.statSync(abs);
      fileMtimes.set(rel, stat.mtimeMs);
      resolvedStems.add(path.basename(rel, ".md").toLowerCase());
    } catch {
      // skip inaccessible files
    }
  }
  return { fileMtimes, resolvedStems };
}

function isResolved(target: string, resolvedStems: Set<string>, vaultRoot: string): boolean {
  const stem = path.basename(target).toLowerCase().replace(/\.md$/i, "");
  if (resolvedStems.has(stem)) return true;
  const candidate = path.join(vaultRoot, target.endsWith(".md") ? target : target + ".md");
  return fs.existsSync(candidate);
}

function readFile(vaultRoot: string, relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(vaultRoot, relPath), "utf-8");
  } catch {
    return null;
  }
}

/**
 * Returns the unresolved wikilink targets found in a single file using the AST
 * parser. No regex scanning.
 */
function extractUnresolvedFromFile(
  vaultRoot: string,
  relPath: string,
  resolvedStems: Set<string>,
  excludeExtensions: Set<string>,
): string[] {
  const text = readFile(vaultRoot, relPath);
  if (text === null) return [];

  const tree = parseMarkdownAST(text);
  const seen = new Set<string>();
  for (const { target } of extractWikiLinks(tree)) {
    if (!target) continue;
    const ext = path.extname(target).toLowerCase();
    if (excludeExtensions.has(ext)) continue;
    if (!isResolved(target, resolvedStems, vaultRoot)) seen.add(target);
  }
  return [...seen];
}

/**
 * Scans a single file and emits (target, Occurrence) pairs for every wikilink
 * whose target is in `expectedTargets`. Context and semantic type come from the
 * AST rather than ad-hoc regexes.
 */
function scanFile(
  vaultRoot: string,
  relPath: string,
  expectedTargets: Set<string>,
  text: string,
): [string, Occurrence][] {
  const tree = parseMarkdownAST(text);
  const results: [string, Occurrence][] = [];

  for (const link of extractWikiLinks(tree)) {
    if (!expectedTargets.has(link.target)) continue;
    const [ctxBefore, ctxAfter] = extractContext(text, link.startOffset, link.endOffset);
    results.push([link.target, {
      source: relPath,
      source_folder: sourceFolder(relPath),
      line: link.line,
      alias: link.alias,
      semantic_type: link.semanticType,
      context_before: ctxBefore,
      context_after: ctxAfter,
    }]);
  }
  return results;
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

  const targetToSources = new Map<string, Set<string>>();
  for (const relPath of filesToScan) {
    const targets = extractUnresolvedFromFile(vaultRoot, relPath, resolvedStems, excludeExtensions);
    for (const t of targets) {
      const s = targetToSources.get(t) ?? new Set();
      s.add(relPath);
      targetToSources.set(t, s);
    }
  }

  const sourceToTargets = new Map<string, Set<string>>();
  for (const [target, srcs] of targetToSources) {
    for (const src of srcs) {
      const ts = sourceToTargets.get(src) ?? new Set();
      ts.add(target);
      sourceToTargets.set(src, ts);
    }
  }

  const occurrencesByTarget = new Map<string, Occurrence[]>();
  let i = 0;
  const total = sourceToTargets.size;
  for (const [source, targets] of sourceToTargets) {
    ++i;
    onProgress?.(i, total);
    const text = readFile(vaultRoot, source);
    if (text === null) continue;
    for (const [target, occ] of scanFile(vaultRoot, source, targets, text)) {
      const list = occurrencesByTarget.get(target) ?? [];
      list.push(occ);
      occurrencesByTarget.set(target, list);
    }
  }

  const links: LinkRecord[] = [];
  for (const target of [...targetToSources.keys()].sort()) {
    const occs = occurrencesByTarget.get(target) ?? [];
    const [cls, conf, feats] = classifier.classify(target, occs);
    if (excludeTypes.has(cls)) continue;
    links.push(linkToRecord({ target, normalized: normalize(target), expected_destination: cls, classification_confidence: conf, title_features: feats, occurrences: occs }));
  }
  return links;
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

  const occurrencesByTarget = new Map<string, Occurrence[]>();
  const oldClassification = new Map<string, [string, string, ReturnType<Classifier["classify"]>[2]]>();

  for (const link of oldLinksRaw) {
    const target = link.target;
    if (isResolved(target, resolvedStems, vaultRoot)) continue;
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

  const newTargetToSources = new Map<string, Set<string>>();
  for (const relPath of filesToRescan) {
    const targets = extractUnresolvedFromFile(vaultRoot, relPath, resolvedStems, excludeExtensions);
    for (const t of targets) {
      targetsStale.add(t);
      const s = newTargetToSources.get(t) ?? new Set();
      s.add(relPath);
      newTargetToSources.set(t, s);
    }
  }

  const newSourceToTargets = new Map<string, Set<string>>();
  for (const [target, srcs] of newTargetToSources) {
    for (const src of srcs) {
      const ts = newSourceToTargets.get(src) ?? new Set();
      ts.add(target);
      newSourceToTargets.set(src, ts);
    }
  }
  let scanDone = 0;
  const scanTotal = newSourceToTargets.size;
  for (const [source, targets] of newSourceToTargets) {
    ++scanDone;
    onProgress?.(scanDone, scanTotal);
    const text = readFile(vaultRoot, source);
    if (text === null) continue;
    for (const [target, occ] of scanFile(vaultRoot, source, targets, text)) {
      const list = occurrencesByTarget.get(target) ?? [];
      list.push(occ);
      occurrencesByTarget.set(target, list);
    }
  }

  const links: LinkRecord[] = [];
  for (const target of [...occurrencesByTarget.keys()].sort()) {
    const occs = occurrencesByTarget.get(target) ?? [];
    let cls: string, conf: string, feats: ReturnType<Classifier["classify"]>[2];
    if (targetsStale.has(target) || !oldClassification.has(target)) {
      [cls, conf, feats] = classifier.classify(target, occs);
    } else {
      [cls, conf, feats] = oldClassification.get(target)!;
    }
    if (excludeTypes.has(cls)) continue;
    links.push(linkToRecord({ target, normalized: normalize(target), expected_destination: cls, classification_confidence: conf, title_features: feats, occurrences: occs }));
  }
  return links;
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
