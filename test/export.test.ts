import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  exportCollection, quantize, readVectorBytes, resolveExportDir, wordList, writeVectorChunks,
  MAX_CHUNK_BYTES, type ExportManifest,
} from "../src/export.js";
import { DEFAULT_CONFIG, type Collection } from "../src/config.js";
import { writeJsonl } from "../src/indexer.js";
import type { LinkRecord } from "../src/types.js";

const DIM = 4;

function link(target: string, context = ""): LinkRecord {
  return {
    target,
    normalized: target.toLowerCase(),
    expected_destination: "idea",
    classification_confidence: "high",
    title_features: {},
    occurrences: [{ source: "a.md", source_folder: "", line: 1, context_before: context, context_after: "" }],
    stats: { total_occurrences: 1, unique_source_folders: 1, semantic_types: [] },
  } as unknown as LinkRecord;
}

// Deterministic fake model: vector derived from text length, so no model download is needed.
let embedCalls: string[][] = [];
async function fakeEmbed(texts: string[]): Promise<Float32Array[]> {
  embedCalls.push(texts);
  return texts.map((t) => Float32Array.from([t.length, 1, 0, 0]));
}

let root: string;
let col: Collection;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "qvoid-export-"));
  const data = path.join(root, "data");
  col = {
    name: "test",
    path: root,
    config: { ...DEFAULT_CONFIG, export: { path: "Out/qvoid" } },
    jsonlPath: path.join(data, "unresolved_links.jsonl"),
    vectorsPath: path.join(data, "vectors.bin"),
    manifestPath: path.join(data, "manifest.json"),
  } as unknown as Collection;
  embedCalls = [];
  const links = [link("Habits compound", "small gains small gains small gains"), link("Focus beats effort")];
  writeJsonl(links, col.jsonlPath);
  // Float32 vectors as `qvoid embed` writes them.
  const vecs = Float32Array.from([3, 4, 0, 0, 0, 0, 0, 2]);
  fs.writeFileSync(col.vectorsPath, Buffer.from(vecs.buffer));
  fs.writeFileSync(col.manifestPath, JSON.stringify({
    model: DEFAULT_CONFIG.embeddings.model, dim: DIM, count: 2, order: links.map((l) => l.target),
  }));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("quantize", () => {
  it("normalizes then scales to int8", () => {
    expect([...quantize([3, 4])]).toEqual([76, 102]);
  });
});

describe("wordList", () => {
  it("includes common words, target words, and context/note words used at least 3 times", () => {
    const words = wordList([link("Habits compound", "small gains small gains small gains rare")], ["the"], ["focus focus", "focus once"]);
    expect(words).toEqual(["compound", "focus", "gains", "habits", "small", "the"]);
  });
});

describe("resolveExportDir", () => {
  it("resolves the configured path against the vault", () => {
    expect(resolveExportDir(col)).toBe(path.join(root, "Out/qvoid"));
  });
  it("returns undefined when nothing is configured", () => {
    expect(resolveExportDir({ ...col, config: DEFAULT_CONFIG } as Collection)).toBeUndefined();
  });
});

describe("exportCollection", () => {
  it("writes records, item vectors from the index, and word vectors", async () => {
    const out = path.join(root, "Out/qvoid");
    const r = await exportCollection(col, out, { embed: fakeEmbed, commonWords: ["the"], noteTexts: [] });
    const m = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf-8")) as ExportManifest;
    const bin = new Int8Array(readVectorBytes(out, m)!);

    expect(m).toMatchObject({ format: "pkm-vectors", version: 2, tool: "qvoid", dim: DIM, scale: 127, files: ["vectors-0.bin"] });
    expect(m.items).toEqual(["Habits compound", "Focus beats effort"]);
    expect([...bin.slice(0, DIM)]).toEqual([76, 102, 0, 0]);
    expect([...bin.slice(DIM, 2 * DIM)]).toEqual([0, 0, 0, 127]);
    expect(bin.length).toBe((m.items.length + m.words.length) * DIM);
    expect(fs.readFileSync(path.join(out, "records.jsonl"), "utf-8")).toBe(fs.readFileSync(col.jsonlPath, "utf-8"));
    expect(r.newlyEmbedded).toBe(m.words.length);
  });

  it("reuses word vectors from the previous export", async () => {
    const out = path.join(root, "Out/qvoid");
    await exportCollection(col, out, { embed: fakeEmbed, commonWords: ["the"], noteTexts: [] });
    embedCalls = [];
    const r = await exportCollection(col, out, { embed: fakeEmbed, commonWords: ["the", "new"], noteTexts: [] });
    expect(embedCalls).toEqual([["new"]]);
    expect(r.newlyEmbedded).toBe(1);
  });
});

describe("vector chunks", () => {
  it("splits on row boundaries under the size limit and reads back identically", () => {
    const dim = 384;
    const rows = Math.ceil((MAX_CHUNK_BYTES * 2.5) / dim);
    const bin = Int8Array.from({ length: rows * dim }, (_, i) => (i % 255) - 127);
    const files = writeVectorChunks(root, bin, dim);
    expect(files).toHaveLength(3);
    for (const f of files) {
      const size = fs.statSync(path.join(root, f)).size;
      expect(size).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
      expect(size % dim).toBe(0);
    }
    expect(Buffer.compare(readVectorBytes(root, { files })!, Buffer.from(bin.buffer))).toBe(0);
  });

  it("removes the v1 vectors.bin and leftover chunks, and still reads v1 exports", () => {
    const dir = path.join(root, "chunks");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "vectors.bin"), Buffer.from([1, 2, 3]));
    expect([...readVectorBytes(dir, {})!]).toEqual([1, 2, 3]);
    fs.writeFileSync(path.join(dir, "vectors-7.bin"), "old");
    expect(writeVectorChunks(dir, new Int8Array(8), 4)).toEqual(["vectors-0.bin"]);
    expect(fs.readdirSync(dir)).toEqual(["vectors-0.bin"]);
  });
});
