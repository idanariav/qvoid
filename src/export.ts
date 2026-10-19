import * as fs from "fs";
import * as path from "path";
import fg from "fast-glob";
import type { Collection } from "./config.js";
import { embedTexts, loadVectors } from "./embeddings.js";
import { readJsonl } from "./indexer.js";
import type { LinkRecord } from "./types.js";

// Portable export ("pkm-vectors" v2, same layout as `qmd export`) so clients without qvoid
// installed — the pkm-rag plugin on mobile — can run `query` and `find-similar`. See docs/EXPORT.md.

export const EXPORT_FORMAT = "pkm-vectors";
export const EXPORT_VERSION = 2;
// Each vector file stays under Obsidian Sync's 5 MB per-file limit (Standard plan).
export const MAX_CHUNK_BYTES = 4 * 1024 * 1024;
const SCALE = 127;
const WORD_RE = /[a-z]{3,20}/g;
const TEXT_WORD_MIN_COUNT = 3;

export interface ExportManifest {
  format: string;
  version: number;
  tool: "qvoid";
  collection: string;
  model: string;
  dim: number;
  scale: number;
  exportedAt: string;
  files: string[];   // vector chunks, concatenated in this order
  items: string[];   // targets, same order as their vector rows
  words: string[];   // rows after the items
}

/** Writes `bin` as row-aligned chunks `vectors-0.bin`, `vectors-1.bin`, … (each at most
 *  MAX_CHUNK_BYTES) and deletes vector files of earlier exports the new set doesn't include. */
export function writeVectorChunks(outDir: string, bin: Int8Array, dim: number): string[] {
  const chunkBytes = Math.max(1, Math.floor(MAX_CHUNK_BYTES / Math.max(dim, 1))) * Math.max(dim, 1);
  const files: string[] = [];
  for (let off = 0; off < bin.length || files.length === 0; off += chunkBytes) {
    const part = bin.subarray(off, Math.min(bin.length, off + chunkBytes));
    const name = `vectors-${files.length}.bin`;
    fs.writeFileSync(path.join(outDir, name), Buffer.from(part.buffer, part.byteOffset, part.byteLength));
    files.push(name);
  }
  for (const f of fs.readdirSync(outDir)) {
    if (/^vectors(-\d+)?\.bin$/.test(f) && !files.includes(f)) fs.unlinkSync(path.join(outDir, f));
  }
  return files;
}

/** An export's vector bytes: v2's `files` chunks in order, or v1's single `vectors.bin`. */
export function readVectorBytes(outDir: string, manifest: { files?: string[] }): Buffer | null {
  const paths = (manifest.files ?? ["vectors.bin"]).map((f) => path.join(outDir, f));
  return paths.every((p) => fs.existsSync(p)) ? Buffer.concat(paths.map((p) => fs.readFileSync(p))) : null;
}

/** Embeds raw texts with the collection's model; injectable so tests don't need the model. */
export type Embedder = (texts: string[], modelName: string) => Promise<Float32Array[]>;

export function quantize(v: ArrayLike<number>): Int8Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  const out = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.round((v[i]! / norm) * SCALE);
  return out;
}

/** Common English words + every target word + words used at least TEXT_WORD_MIN_COUNT times
 *  across link contexts and note texts. Queries are arbitrary phrases, so link contexts alone
 *  miss many everyday topic words (e.g. "procrastination"). */
export function wordList(links: LinkRecord[], commonWords: string[], noteTexts: string[] = []): string[] {
  const words = new Set(commonWords);
  const counts = new Map<string, number>();
  const count = (text: string) => {
    for (const w of text.toLowerCase().match(WORD_RE) ?? []) counts.set(w, (counts.get(w) ?? 0) + 1);
  };
  for (const l of links) {
    for (const w of l.target.toLowerCase().match(WORD_RE) ?? []) words.add(w);
    for (const o of l.occurrences) count(`${o.context_before} ${o.context_after}`);
  }
  for (const t of noteTexts) count(t);
  for (const [w, n] of counts) if (n >= TEXT_WORD_MIN_COUNT) words.add(w);
  return [...words].sort();
}

/** Note texts under the collection's origin folders (whole vault if none), without the
 *  Excalidraw/Sketch Editor data block that starts at a `%%` line. */
function readNoteTexts(col: Collection): string[] {
  const folders = col.config.source.origin_folders;
  const patterns = folders.length > 0 ? folders.map((f) => `${fg.escapePath(f)}/**/*.md`) : ["**/*.md"];
  return fg.sync(patterns, { cwd: col.path, absolute: true, suppressErrors: true, dot: false })
    .map((file) => fs.readFileSync(file, "utf-8").split(/^%%$/m)[0]!);
}

function readCommonWords(): string[] {
  const file = new URL("../assets/common-words.txt", import.meta.url);
  return fs.readFileSync(file, "utf-8").split("\n").map((w) => w.trim()).filter(Boolean);
}

/** Export directory: explicit `out`, else `[export] path` (relative to the vault), else none. */
export function resolveExportDir(col: Collection, out?: string): string | undefined {
  const dir = out ?? col.config.export?.path;
  if (!dir) return undefined;
  return path.isAbsolute(dir) ? dir : path.resolve(out ? process.cwd() : col.path, dir);
}

/** Word vectors from the previous export, reusable when model and dim are unchanged. */
function previousWordVectors(outDir: string, model: string, dim: number): Map<string, Int8Array> {
  const prev = new Map<string, Int8Array>();
  const manifestPath = path.join(outDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return prev;
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as ExportManifest;
    if (m.format !== EXPORT_FORMAT || m.model !== model || m.dim !== dim) return prev;
    const bin = readVectorBytes(outDir, m);
    if (!bin) return prev;
    m.words.forEach((w, i) => {
      prev.set(w, new Int8Array(bin.buffer, bin.byteOffset + (m.items.length + i) * dim, dim));
    });
  } catch {
    // Unreadable previous export: re-embed everything.
  }
  return prev;
}

export interface ExportResult {
  outDir: string;
  records: number;
  items: number;
  words: number;
  newlyEmbedded: number;
  bytes: number;
}

export async function exportCollection(
  col: Collection,
  outDir: string,
  opts: { embed?: Embedder; commonWords?: string[]; noteTexts?: string[] } = {},
): Promise<ExportResult> {
  const embed = opts.embed ?? ((texts, model) => embedTexts(texts, model));
  const model = col.config.embeddings.model;
  const links = readJsonl(col.jsonlPath);

  // Items: the vectors `qvoid embed` already built — no re-embedding.
  let items: string[] = [];
  let itemVecs: Int8Array[] = [];
  let dim = 0;
  if (fs.existsSync(col.vectorsPath) && fs.existsSync(col.manifestPath)) {
    const { vectors, manifest } = loadVectors(col.vectorsPath, col.manifestPath);
    if (manifest.model === model) {
      items = manifest.order;
      itemVecs = vectors.map((v) => quantize(v));
      dim = manifest.dim;
    }
  }

  // Words: query-side vectors, so a typed phrase maps to a vector without a model.
  const words = wordList(links, opts.commonWords ?? readCommonWords(), opts.noteTexts ?? readNoteTexts(col));
  const prev = dim > 0 ? previousWordVectors(outDir, model, dim) : new Map<string, Int8Array>();
  const missing = words.filter((w) => !prev.has(w));
  const wordVecs = new Map(prev);
  if (missing.length > 0) {
    const vecs = await embed(missing, model);
    if (dim === 0) dim = vecs[0]?.length ?? 0;
    missing.forEach((w, i) => wordVecs.set(w, quantize(vecs[i]!)));
  }

  fs.mkdirSync(outDir, { recursive: true });
  const bin = new Int8Array((itemVecs.length + words.length) * dim);
  itemVecs.forEach((v, i) => bin.set(v, i * dim));
  words.forEach((w, i) => bin.set(wordVecs.get(w)!, (itemVecs.length + i) * dim));
  fs.copyFileSync(col.jsonlPath, path.join(outDir, "records.jsonl"));
  const files = writeVectorChunks(outDir, bin, dim);
  const manifest: ExportManifest = {
    format: EXPORT_FORMAT, version: EXPORT_VERSION, tool: "qvoid", collection: col.name,
    model, dim, scale: SCALE, exportedAt: new Date().toISOString(), files, items, words,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest));

  return {
    outDir, records: links.length, items: items.length, words: words.length,
    newlyEmbedded: missing.length, bytes: bin.length,
  };
}
