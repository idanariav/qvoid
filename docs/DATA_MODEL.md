# Data Model

All core interfaces live in `src/types.ts`.

## Occurrence

One record per place a wikilink target appears in the vault.

| Field | Type | Description |
|---|---|---|
| `source` | `string` | Relative file path from vault root (e.g. `Notes/Ideas.md`) |
| `source_folder` | `string` | First two path segments (e.g. `Notes/Ideas`) — used for origin filtering |
| `line` | `number` | 1-indexed line number in the source file |
| `alias` | `string?` | Display alias if `[[target\|alias]]` syntax was used |
| `semantic_type` | `string?` | Inline field key from `(Type:: [[target]])` — e.g. `Supports`, `Related` |
| `context_before` | `string` | Up to 200 characters before the wikilink (sentence-level window) |
| `context_after` | `string` | Up to 200 characters after the wikilink |

Extracted by `extractWikiLinks()` + `extractContext()` in `src/parser.ts`.

## TitleFeatures

Boolean/numeric signals derived from the target string alone — used by the classifier's heuristic pass.

| Field | Type | What triggers it |
|---|---|---|
| `word_count` | `number` | Space-separated word count |
| `has_person_prefix` | `boolean` | Target starts with configured `person_prefix` (default `@`) |
| `is_date` | `boolean` | Matches `YYYY-MM-DD`, `YYYY-MM`, `YYYY-Www`, or `YYYY-Qn` |
| `is_all_caps` | `boolean` | All-uppercase and contains at least one letter |
| `is_short_camelcase` | `boolean` | Single word, `PascalCase` pattern (`/^[A-Z][a-z]+([A-Z][a-z]+)+$/`) |
| `has_year_in_parens` | `boolean` | Contains `(YYYY)` — academic citation signal |
| `has_template_syntax` | `boolean` | Contains `<%`, `%>`, `{{`, or `}}` |
| `has_verb` | `boolean` | Contains common English verbs (is/are/improves/affects/etc.) |
| `is_title_case_name` | `boolean` | 2–3 words all in Title-Case — person name pattern |

Computed by `titleFeatures(target, personPrefix)` in `src/classifier.ts`.

## UnresolvedLink

One record per unique unresolved target across the vault.

```typescript
interface UnresolvedLink {
  target: string;                    // Raw wikilink target
  normalized: string;                // Lowercase, trimmed, whitespace-collapsed
  expected_destination: string;      // "idea" | "person" | "date" | "file" | "template" | "unknown"
  classification_confidence: string; // "high" | "medium" | "low"
  title_features: TitleFeatures;
  occurrences: Occurrence[];
}
```

## LinkRecord

`UnresolvedLink` plus pre-computed stats. This is the unit stored in JSONL.

```typescript
interface LinkRecord extends UnresolvedLink {
  stats: LinkStats;  // computed by linkToRecord() in types.ts
}

interface LinkStats {
  total_occurrences: number;
  unique_source_folders: number;
  semantic_types: string[];   // deduplicated, sorted
}
```

`linkToRecord(link)` in `src/types.ts` builds `stats` from `occurrences`.

## JSONL Index

`unresolved_links.jsonl` — one serialised `LinkRecord` per line, written by `writeJsonl()` and read back by `readJsonl()` in `src/indexer.ts`. No schema file; the TypeScript interface is the schema.

## VectorManifest

Stored as `manifest.json` alongside `vectors.bin`.

```typescript
interface VectorManifest {
  model: string;    // e.g. "Xenova/all-MiniLM-L6-v2"
  dim: number;      // embedding dimension (384 for MiniLM)
  count: number;    // total vectors
  order: string[];  // order[i] = target string for row i in vectors.bin
}
```

`vectors.bin` is a flat `Float32Array` buffer, row-major. Row `i` spans bytes `[i * dim * 4, (i+1) * dim * 4)`. Defined in `src/embeddings.ts`.

## Collection Class

`Collection` in `src/config.ts` wraps a registered vault and exposes all data-file paths as getters:

| Getter | Returns |
|---|---|
| `dataDir` | `~/.local/share/qvoid/<name>/` |
| `jsonlPath` | `<dataDir>/unresolved_links.jsonl` |
| `vectorsPath` | `<dataDir>/vectors.bin` |
| `manifestPath` | `<dataDir>/manifest.json` |
| `scanManifestPath` | `<dataDir>/scan_manifest.json` |

Always use these getters — never construct data paths manually.
