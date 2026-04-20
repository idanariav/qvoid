import * as fs from "fs";
import * as path from "path";
import fg from "fast-glob";
import type { CollectionConfig } from "./config.js";
import { Classifier } from "./classifier.js";
import { type LinkRecord, type Occurrence, linkToRecord } from "./types.js";

const WIKILINK_RE = /\[\[([^\[\]]+?)\]\]/g;
const CONTEXT_CHAR_WINDOW = 200;
const SENTENCE_BOUNDARY_RE = /(?<=[.!?])\s+/;

function normalize(target: string): string {
  return target.trim().toLowerCase().replace(/\s+/g, " ");
}

function parseWikilink(raw: string): [string, string | undefined] {
  let target = raw;
  let alias: string | undefined;
  if (target.includes("|")) {
    const idx = target.indexOf("|");
    alias = target.slice(idx + 1).trim();
    target = target.slice(0, idx);
  }
  for (const sep of ["#", "^"]) {
    const idx = target.indexOf(sep);
    if (idx !== -1) target = target.slice(0, idx);
  }
  return [target.trim(), alias];
}

function extractContext(line: string, start: number, end: number): [string, string] {
  const beforeRaw = line.slice(0, start).trimEnd();
  const afterRaw = line.slice(end).trimStart();

  let before = beforeRaw.slice(-CONTEXT_CHAR_WINDOW);
  const sentencesBefore = before.split(SENTENCE_BOUNDARY_RE);
  if (sentencesBefore.length > 1) before = sentencesBefore[sentencesBefore.length - 1]!;

  let after = afterRaw.slice(0, CONTEXT_CHAR_WINDOW);
  const sentencesAfter = after.split(SENTENCE_BOUNDARY_RE);
  if (sentencesAfter.length > 1) after = sentencesAfter[0]!;

  return [before.trim(), after.trim()];
}

function extractSemanticType(line: string, start: number, annotationRe: RegExp | null): string | undefined {
  if (!annotationRe) return undefined;
  const segment = line.slice(Math.max(0, start - 40), start);
  const m = annotationRe.exec(segment);
  return m?.[1];
}

function sourceFolder(sourcePath: string): string {
  const parts = sourcePath.split("/");
  if (parts.length >= 2) return parts.slice(0, 2).join("/");
  return parts[0] ?? sourcePath;
}

function compileAnnotationPattern(raw: string): RegExp | null {
  if (!raw) return null;
  try {
    return new RegExp(raw);
  } catch (e) {
    throw new Error(`Invalid annotation_pattern ${JSON.stringify(raw)}: ${e}`);
  }
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

function extractUnresolvedFromFile(
  vaultRoot: string,
  relPath: string,
  resolvedStems: Set<string>,
  excludeExtensions: Set<string>,
): string[] {
  const abs = path.join(vaultRoot, relPath);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf-8");
  } catch {
    return [];
  }

  const targets: string[] = [];
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(text)) !== null) {
    const [target] = parseWikilink(m[1]!);
    if (!target) continue;
    const ext = path.extname(target).toLowerCase();
    if (excludeExtensions.has(ext)) continue;
    if (!isResolved(target, resolvedStems, vaultRoot)) {
      targets.push(target);
    }
  }
  return targets;
}

function scanFile(
  vaultRoot: string,
  relPath: string,
  expectedTargets: Set<string>,
  annotationRe: RegExp | null,
): [string, Occurrence][] {
  const abs = path.join(vaultRoot, relPath);
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf-8");
  } catch {
    return [];
  }

  const results: [string, Occurrence][] = [];
  const lines = text.split("\n");
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx]!;
    WIKILINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = WIKILINK_RE.exec(line)) !== null) {
      const [target, alias] = parseWikilink(m[1]!);
      if (!expectedTargets.has(target)) continue;
      const [ctxBefore, ctxAfter] = extractContext(line, m.index, m.index + m[0].length);
      const sem = extractSemanticType(line, m.index, annotationRe);
      results.push([target, {
        source: relPath,
        source_folder: sourceFolder(relPath),
        line: lineIdx + 1,
        alias,
        semantic_type: sem,
        context_before: ctxBefore,
        context_after: ctxAfter,
      }]);
    }
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
    // Support old flat format ({path: mtime}) by checking for a "files" key
    if ("files" in raw && typeof raw["files"] === "object" && raw["files"] !== null) {
      return {
        origin_folders: Array.isArray(raw["origin_folders"]) ? raw["origin_folders"] as string[] : [],
        files: new Map(Object.entries(raw["files"] as Record<string, number>)),
      };
    }
    // Legacy flat format — treat as no manifest so a full build runs
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
  annotationRe: RegExp | null,
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
    for (const [target, occ] of scanFile(vaultRoot, source, targets, annotationRe)) {
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
  annotationRe: RegExp | null,
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
    for (const [target, occ] of scanFile(vaultRoot, source, targets, annotationRe)) {
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
  const annotationRe = compileAnnotationPattern(sourceCfg.annotation_pattern);
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
      annotationRe, originFolders, excludeExtensions, excludeTypes,
      classifier, opts.existingJsonl!, opts.onProgress,
    );
  } else {
    links = await fullBuild(
      vaultRoot, fileMtimes, resolvedStems,
      annotationRe, originFolders, excludeExtensions, excludeTypes,
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
