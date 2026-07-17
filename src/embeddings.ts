import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type { LinkRecord } from "./types.js";

// Silence HuggingFace hub noise; never fetch model after first download.
process.env["HF_HUB_OFFLINE"] ??= "1";
process.env["TRANSFORMERS_OFFLINE"] ??= "1";
process.env["TRANSFORMERS_VERBOSITY"] ??= "error";
process.env["HF_HUB_DISABLE_PROGRESS_BARS"] ??= "1";

type HFTensor = { data: Float32Array; dims: number[] };

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

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
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
  // Content hash per target (same index as `order`); absent on pre-hash manifests.
  hashes?: string[];
}

function loadVectors(vectorsPath: string, manifestPath: string): { vectors: Float32Array[]; manifest: VectorManifest } {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as VectorManifest;
  const buf = fs.readFileSync(vectorsPath);
  const raw = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const { dim, count } = manifest;
  const vectors: Float32Array[] = [];
  for (let i = 0; i < count; i++) {
    vectors.push(raw.subarray(i * dim, (i + 1) * dim));
  }
  return { vectors, manifest };
}

export async function buildVectors(
  links: LinkRecord[],
  vectorsPath: string,
  manifestPath: string,
  modelName: string,
  onProgress?: (done: number, total: number) => void,
): Promise<void> {
  // Load existing vectors if model matches — skip targets whose content hash is unchanged
  const existing = new Map<string, { vec: Float32Array; hash: string | undefined }>();
  if (fs.existsSync(manifestPath) && fs.existsSync(vectorsPath)) {
    const { vectors, manifest } = loadVectors(vectorsPath, manifestPath);
    if (manifest.model === modelName) {
      for (let i = 0; i < manifest.order.length; i++) {
        existing.set(manifest.order[i]!, { vec: vectors[i]!, hash: manifest.hashes?.[i] });
      }
    }
  }

  const textByTarget = new Map(links.map((l) => [l.target, documentText(l)] as const));
  const hashByTarget = new Map(links.map((l) => [l.target, textHash(textByTarget.get(l.target)!)] as const));

  // A target needs (re-)embedding if it's new, or its content changed since it was last embedded.
  // Pre-hash manifest entries (hash === undefined) are reused once rather than forcing a mass re-embed.
  const newLinks = links.filter((l) => {
    const prior = existing.get(l.target);
    if (!prior) return true;
    if (prior.hash === undefined) return false;
    return prior.hash !== hashByTarget.get(l.target);
  });
  const skipped = links.length - newLinks.length;

  if (newLinks.length === 0) {
    onProgress?.(links.length, links.length);
    return;
  }

  const pipe = await loadModel(modelName) as (texts: string[], opts: unknown) => Promise<HFTensor>;
  const texts = newLinks.map((l) => textByTarget.get(l.target)!);

  const batchSize = 64;
  const newVecs = new Map<string, Float32Array>();
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const outputs = await pipe(batch, { pooling: "mean", normalize: true });
    const hiddenDim = outputs.dims[1] ?? outputs.data.length / batch.length;
    for (let j = 0; j < batch.length; j++) {
      newVecs.set(newLinks[i + j]!.target, outputs.data.slice(j * hiddenDim, (j + 1) * hiddenDim));
    }
    onProgress?.(skipped + Math.min(i + batchSize, texts.length), links.length);
  }

  // Merge: preserve order from links (drops removed targets automatically). Freshly
  // (re-)embedded vectors take priority over any stale cached entry for the same target.
  const allVecs: Float32Array[] = links.map((l) => newVecs.get(l.target) ?? existing.get(l.target)!.vec);
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
    hashes: links.map((l) => hashByTarget.get(l.target)!),
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
    const pipe = await loadModel(manifest.model) as (texts: string[], opts: unknown) => Promise<HFTensor>;
    const outputs = await pipe([query], { pooling: "mean", normalize: true });
    qVec = normalizeVec(outputs.data.slice(0, outputs.dims[1]));
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

  for (let i = 0; i < n; i++) {
    const vi = vectors[i]!;
    for (let j = i + 1; j < n; j++) {
      const sim = dotProduct(vi, vectors[j]!);
      if (sim >= threshold) union(i, j);
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
