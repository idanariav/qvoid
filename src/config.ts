import * as fs from "fs";
import * as path from "path";
import { parse, stringify } from "smol-toml";
import {
  collectionConfigPath,
  collectionDataDir,
  registryPath,
} from "./paths.js";

export const DEFAULT_CONFIG = {
  source: {
    origin_folders: [] as string[],
    annotation_pattern: String.raw`\(([A-Za-z]+)::\s*$`,
    exclude_extensions: [
      ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp",
      ".excalidraw", ".pdf", ".mp4", ".mov", ".mp3", ".wav", ".zip",
    ],
  },
  classifier: {
    exclude_types: [] as string[],
    citation_folders: [] as string[],
    strong_idea_annotations: ["Supports", "Opposes", "Weakens", "Reminds"],
    weak_idea_annotations: ["Jump", "Related", "Aka"],
    person_prefix: "@",
    heuristics: {
      date: true,
      person: true,
      file_extensions: true,
      camelcase: true,
      template: true,
      capitalization: true,
      min_words_for_idea: 4,
      verb_identification: true,
    },
  },
  embeddings: {
    model: "Xenova/all-MiniLM-L6-v2",
  },
} as const;

export type CollectionConfig = typeof DEFAULT_CONFIG;

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

function mergeDefaults(cfg: Record<string, unknown>): CollectionConfig {
  const result: Record<string, unknown> = {};
  for (const [section, sectionDefaults] of Object.entries(DEFAULT_CONFIG)) {
    const userSection = (cfg[section] ?? {}) as Record<string, unknown>;
    const merged: Record<string, unknown> = { ...sectionDefaults as Record<string, unknown> };
    for (const [key, userVal] of Object.entries(userSection)) {
      const defaultVal = (sectionDefaults as Record<string, unknown>)[key];
      if (defaultVal !== null && typeof defaultVal === "object" && !Array.isArray(defaultVal) &&
          userVal !== null && typeof userVal === "object" && !Array.isArray(userVal)) {
        merged[key] = { ...defaultVal as object, ...userVal as object };
      } else {
        merged[key] = userVal;
      }
    }
    result[section] = merged;
  }
  return result as unknown as CollectionConfig;
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
      `or \`qvoid init --name <n> --path <vault>\` to register.`
    );
  }
  const cfgPath = collectionConfigPath(name);
  const rawCfg = fs.existsSync(cfgPath) ? readToml(cfgPath) : {};
  return new Collection(name, entry.path, mergeDefaults(rawCfg));
}

export function resolveCollection(name?: string): Collection {
  if (!name) name = process.env["QVOID_COLLECTION"];
  const collections = listCollections();
  if (Object.keys(collections).length === 0) {
    throw new Error("No collections registered. Run `qvoid init --name <n> --path <vault>`.");
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

export function updateCollectionConfig(name: string, section: string, updates: Record<string, unknown>): void {
  const cfgPath = collectionConfigPath(name);
  const cfg = fs.existsSync(cfgPath) ? readToml(cfgPath) : {};
  const existing = (cfg[section] ?? {}) as Record<string, unknown>;
  cfg[section] = { ...existing, ...updates };
  writeToml(cfgPath, cfg);
}
