import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { buildIndex, writeJsonl, readJsonl } from "../src/indexer.js";
import { Classifier } from "../src/classifier.js";
import { DEFAULT_CONFIG } from "../src/config.js";

let vaultRoot: string;
let jsonlPath: string;
let manifestPath: string;

beforeEach(() => {
  vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), "qvoid-test-"));
  jsonlPath = path.join(vaultRoot, ".qvoid", "unresolved_links.jsonl");
  manifestPath = path.join(vaultRoot, ".qvoid", "scan_manifest.json");
});

afterEach(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function writeFile(rel: string, content: string): void {
  const full = path.join(vaultRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

async function build() {
  const classifier = new Classifier(DEFAULT_CONFIG);
  const links = await buildIndex(vaultRoot, DEFAULT_CONFIG, classifier, {
    existingJsonl: jsonlPath,
    scanManifestPath: manifestPath,
  });
  writeJsonl(links, jsonlPath);
  return links;
}

function targets(links: Awaited<ReturnType<typeof build>>): string[] {
  return links.map((l) => l.target).sort();
}

describe("full build", () => {
  it("discovers unresolved links across multiple files", async () => {
    writeFile("a.md", "See [[Unresolved One]].");
    writeFile("b.md", "See [[Unresolved One]] and [[Unresolved Two]].");
    const links = await build();
    expect(targets(links)).toEqual(["Unresolved One", "Unresolved Two"]);
    const one = links.find((l) => l.target === "Unresolved One")!;
    expect(one.stats.total_occurrences).toBe(2);
  });

  it("excludes targets that resolve to a real file in the vault", async () => {
    writeFile("Real Note.md", "# Real Note");
    writeFile("a.md", "See [[Real Note]] and [[Fake Note]].");
    const links = await build();
    expect(targets(links)).toEqual(["Fake Note"]);
  });

  it("excludes targets with a default-excluded extension", async () => {
    writeFile("a.md", "See [[diagram.png]] and [[Real Target]].");
    const links = await build();
    expect(targets(links)).toEqual(["Real Target"]);
  });
});

describe("incremental build", () => {
  it("is a no-op when nothing changed", async () => {
    writeFile("a.md", "See [[Target A]].");
    await build();
    const spy = vi.spyOn(Classifier.prototype, "classify");
    const links = await build();
    expect(targets(links)).toEqual(["Target A"]);
    expect(spy).not.toHaveBeenCalled();
  });

  it("rescans only the modified file and retains occurrences from unchanged files", async () => {
    writeFile("a.md", "See [[Target A]].");
    writeFile("b.md", "See [[Target B]].");
    await build();

    // Ensure the mtime actually advances on fast filesystems/clocks.
    await new Promise((r) => setTimeout(r, 20));
    writeFile("b.md", "See [[Target B]] and [[Target C]].");
    const links = await build();

    expect(targets(links)).toEqual(["Target A", "Target B", "Target C"]);
  });

  it("does not reclassify targets whose occurrences are untouched", async () => {
    writeFile("a.md", "See [[Target A]].");
    writeFile("b.md", "See [[Target B]].");
    await build();

    await new Promise((r) => setTimeout(r, 20));
    writeFile("b.md", "See [[Target B]] and [[Target C]].");

    const spy = vi.spyOn(Classifier.prototype, "classify");
    await build();
    const classifiedTargets = spy.mock.calls.map((c) => c[0]);
    expect(classifiedTargets).not.toContain("Target A");
    expect(classifiedTargets).toEqual(expect.arrayContaining(["Target B", "Target C"]));
  });

  it("drops a target entirely once its last occurrence's source file is deleted", async () => {
    writeFile("a.md", "See [[Target A]].");
    writeFile("b.md", "See [[Target A]] and [[Target B]].");
    await build();

    await new Promise((r) => setTimeout(r, 20));
    fs.rmSync(path.join(vaultRoot, "b.md"));
    const links = await build();

    // Target A survives via a.md; Target B had no other occurrences and is dropped
    // entirely rather than persisted as a zero-occurrence record.
    expect(targets(links)).toEqual(["Target A"]);
    const a = links.find((l) => l.target === "Target A")!;
    expect(a.stats.total_occurrences).toBe(1);
  });

  it("survives a round trip through writeJsonl/readJsonl", async () => {
    writeFile("a.md", "See [[Target A]].");
    const links = await build();
    const reread = readJsonl(jsonlPath);
    expect(reread).toEqual(links);
  });
});
