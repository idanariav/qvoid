import * as fs from "fs";
import * as path from "path";
import { z } from "zod";
import { parse, stringify } from "smol-toml";
import {
  collectionConfigPath,
  collectionDataDir,
  registryPath,
} from "./paths.js";

const HeuristicsSchema = z.strictObject({
  date: z.boolean().default(true),
  person: z.boolean().default(true),
  file_extensions: z.boolean().default(true),
  camelcase: z.boolean().default(true),
  template: z.boolean().default(true),
  capitalization: z.boolean().default(true),
  min_words_for_idea: z.number().default(4),
  verb_identification: z.boolean().default(true),
});

const SourceSchema = z.strictObject({
  origin_folders: z.array(z.string()).default([]),
  exclude_extensions: z.array(z.string()).default([
    ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp",
    ".excalidraw", ".pdf", ".mp4", ".mov", ".mp3", ".wav", ".zip",
  ]),
});

const ClassifierSchema = z.strictObject({
  exclude_types: z.array(z.string()).default([]),
  citation_folders: z.array(z.string()).default([]),
  strong_idea_annotations: z.array(z.string()).default(["Supports", "Opposes", "Weakens", "Reminds"]),
  weak_idea_annotations: z.array(z.string()).default(["Jump", "Related", "Aka"]),
  person_prefix: z.string().default("@"),
  heuristics: HeuristicsSchema.default(HeuristicsSchema.parse({})),
});

const EmbeddingsSchema = z.strictObject({
  model: z.string().default("Xenova/bge-small-en-v1.5"),
});

const CollectionConfigSchema = z.strictObject({
  source: SourceSchema.default(SourceSchema.parse({})),
  classifier: ClassifierSchema.default(ClassifierSchema.parse({})),
  embeddings: EmbeddingsSchema.default(EmbeddingsSchema.parse({})),
});

export type CollectionConfig = z.infer<typeof CollectionConfigSchema>;

export const DEFAULT_CONFIG: CollectionConfig = CollectionConfigSchema.parse({});

export class Collection {
  constructor(
    public readonly name: string,
    public readonly path: string,
    public readonly config: CollectionConfig,
  ) {}

  get dataDir(): string { return collectionDataDir(this.name); }
  get jsonlPath(): string { return path.join(this.dataDir, "unresolved_links.jsonl"); }
  get vectorsPath(): string { return path.join(this.dataDir, "vectors.bin"); }
  get manifestPath(): string { return path.join(this.dataDir, "manifest.json"); }
  get scanManifestPath(): string { return path.join(this.dataDir, "scan_manifest.json"); }
}

function readToml(filePath: string): Record<string, unknown> {
  return parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
}

function writeToml(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, stringify(data as Parameters<typeof stringify>[0]));
}

function parseConfig(cfg: Record<string, unknown>, cfgPath: string): CollectionConfig {
  const result = CollectionConfigSchema.safeParse(cfg);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid config at ${cfgPath}:\n${issues}`);
  }
  return result.data;
}

interface Registry {
  collections: Record<string, { path: string }>;
}

function loadRegistry(): Registry {
  const p = registryPath();
  if (!fs.existsSync(p)) return { collections: {} };
  const data = readToml(p) as { collections?: Record<string, { path: string }> };
  return { collections: data["collections"] ?? {} };
}

function saveRegistry(registry: Registry): void {
  writeToml(registryPath(), registry);
}

export function registerCollection(name: string, vaultPath: string): void {
  const registry = loadRegistry();
  registry.collections[name] = { path: path.resolve(vaultPath) };
  saveRegistry(registry);
  const cfgPath = collectionConfigPath(name);
  if (!fs.existsSync(cfgPath)) {
    writeToml(cfgPath, DEFAULT_CONFIG);
  }
}

export function removeCollection(name: string): boolean {
  const registry = loadRegistry();
  if (!(name in registry.collections)) return false;
  delete registry.collections[name];
  saveRegistry(registry);
  return true;
}

export function listCollections(): Record<string, { path: string }> {
  return loadRegistry().collections;
}

export function loadCollection(name: string): Collection {
  const registry = loadRegistry();
  const entry = registry.collections[name];
  if (!entry) {
    throw new Error(
      `Unknown collection: ${JSON.stringify(name)}. Run \`qvoid collections\` to list, ` +
      `or \`qvoid collection <name> --path <vault>\` to register.`
    );
  }
  const cfgPath = collectionConfigPath(name);
  const rawCfg = fs.existsSync(cfgPath) ? readToml(cfgPath) : {};
  return new Collection(name, entry.path, parseConfig(rawCfg, cfgPath));
}

export function resolveCollection(name?: string): Collection {
  if (!name) name = process.env["QVOID_COLLECTION"];
  const collections = listCollections();
  if (Object.keys(collections).length === 0) {
    throw new Error("No collections registered. Run `qvoid collection <name> --path <vault>`.");
  }
  if (name) return loadCollection(name);

  const cwd = path.resolve(process.cwd());
  for (const [cname, entry] of Object.entries(collections)) {
    const cpath = path.resolve(entry.path);
    if (cwd.startsWith(cpath + path.sep) || cwd === cpath) {
      return loadCollection(cname);
    }
  }

  const names = Object.keys(collections);
  if (names.length === 1) return loadCollection(names[0]!);

  throw new Error(
    "Multiple collections registered and CWD is outside all of them. " +
    "Pass --collection <name> or set QVOID_COLLECTION."
  );
}
