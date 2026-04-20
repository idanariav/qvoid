import * as fs from "fs";
import * as path from "path";
import type { LinkRecord } from "./types.js";

// Silence HuggingFace hub noise; never fetch model after first download.
process.env["HF_HUB_OFFLINE"] ??= "1";
process.env["TRANSFORMERS_OFFLINE"] ??= "1";
process.env["TRANSFORMERS_VERBOSITY"] ??= "error";
process.env["HF_HUB_DISABLE_PROGRESS_BARS"] ??= "1";

let cachedPipeline: unknown = null;
let cachedModelName = "";

async function loadModel(modelName: string) {
  if (cachedPipeline && cachedModelName === modelName) return cachedPipeline;
  const { pipeline } = await import("@huggingface/transformers");
  cachedPipeline = await pipeline("feature-extraction", modelName, { dtype: "fp32" });
  cachedModelName = modelName;
  return cachedPipeline;
}

function documentText(link: LinkRecord): string {
  const parts = [link.target];
  for (const occ of link.occurrences.slice(0, 5)) {
    const snippet = `${occ.context_before} [[...]] ${occ.context_after}`.trim();
    if (snippet) parts.push(snippet);
    if (occ.semantic_type) parts.push(`(${occ.semantic_type})`);
  }
  return parts.join(" | ");
}

function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] ?? 0) * (b[i] ?? 0);
  return sum;
}

function normalizeVec(v: Float32Array): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm);
  if (norm === 0) return v;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = (v[i] ?? 0) / norm;
  return out;
}

interface VectorManifest {
  model: string;
  dim: number;
  count: number;
  order: string[];
}

function loadVectors(vectorsPath: string, manifestPath: string): { vectors: Float32Array[]; manifest: VectorManifest } {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as VectorManifest;
  const buf = fs.readFileSync(vectorsPath);
  const raw = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const { dim, count } = manifest;
  const vectors: Float32Array[] = [];
  for (let i = 0; i < count; i++) {
    vectors.push(raw.slice(i * dim, (i + 1) * dim));
  }
  return { vectors, manifest };
}

export async function buildVectors(
  links: LinkRecord[],
  vectorsPath: string,
  manifestPath: string,
  modelName: string,
): Promise<void> {
  const pipe = await loadModel(modelName) as (texts: string[], opts: unknown) => Promise<{ data: Float32Array }[]>;
  const texts = links.map(documentText);

  process.stderr.write(`Encoding ${texts.length} documents...\n`);
  const batchSize = 64;
  const allVecs: Float32Array[] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const outputs = await pipe(batch, { pooling: "mean", normalize: true });
    for (const out of outputs) {
      allVecs.push(new Float32Array(out.data));
    }
  }

  const dim = allVecs[0]?.length ?? 0;
  const flatBuf = new Float32Array(allVecs.length * dim);
  for (let i = 0; i < allVecs.length; i++) {
    flatBuf.set(allVecs[i]!, i * dim);
  }

  fs.mkdirSync(path.dirname(vectorsPath), { recursive: true });
  fs.writeFileSync(vectorsPath, Buffer.from(flatBuf.buffer));

  const manifest: VectorManifest = {
    model: modelName,
    dim,
    count: allVecs.length,
    order: links.map((l) => l.target),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

export async function findSimilar(
  query: string,
  vectorsPath: string,
  manifestPath: string,
  opts: { topK?: number; minScore?: number } = {},
): Promise<{ target: string; score: number }[]> {
  const { topK = 10, minScore = 0.0 } = opts;
  const { vectors, manifest } = loadVectors(vectorsPath, manifestPath);

  let qVec: Float32Array;
  const idx = manifest.order.indexOf(query);
  if (idx !== -1) {
    qVec = vectors[idx]!;
  } else {
    const pipe = await loadModel(manifest.model) as (texts: string[], opts: unknown) => Promise<{ data: Float32Array }[]>;
    const outputs = await pipe([query], { pooling: "mean", normalize: true });
    qVec = normalizeVec(new Float32Array(outputs[0]!.data));
  }

  const scored = vectors.map((v, i) => ({ target: manifest.order[i]!, score: dotProduct(v, qVec) }));
  scored.sort((a, b) => b.score - a.score);

  const results: { target: string; score: number }[] = [];
  for (const { target, score } of scored) {
    if (target === query) continue;
    if (score < minScore) break;
    results.push({ target, score });
    if (results.length >= topK) break;
  }
  return results;
}

export function clusterDuplicates(
  vectorsPath: string,
  manifestPath: string,
  threshold = 0.82,
): string[][] {
  const { vectors, manifest } = loadVectors(vectorsPath, manifestPath);
  const n = vectors.length;
  const parent = Array.from({ length: n }, (_, i) => i);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  }
  function union(a: number, b: number): void {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const CHUNK = 256;
  for (let start = 0; start < n; start += CHUNK) {
    const end = Math.min(start + CHUNK, n);
    for (let i = start; i < end; i++) {
      const vi = vectors[i]!;
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const sim = dotProduct(vi, vectors[j]!);
        if (sim >= threshold) union(i, j);
      }
    }
  }

  const groups = new Map<number, string[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r) ?? [];
    g.push(manifest.order[i]!);
    groups.set(r, g);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => g.sort());
}
