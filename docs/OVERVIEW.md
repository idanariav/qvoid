# qvoid — Architecture Overview

qvoid indexes every `[[wikilink]]` in an Obsidian-style markdown vault, identifies which targets have no matching file (unresolved), classifies each by probable type (idea / person / date / file / template / unknown), and exposes query and similarity-search over the result set via CLI and MCP server.

## Source Layout

| File | Responsibility |
|---|---|
| `src/types.ts` | Core data interfaces (`Occurrence`, `LinkRecord`, `TitleFeatures`, `LinkStats`) |
| `src/parser.ts` | Markdown AST parsing; custom micromark extensions for `[[wikilinks]]` and `(key:: value)` inline fields |
| `src/indexer.ts` | Vault walk, two-pass extraction, incremental build logic, JSONL I/O |
| `src/classifier.ts` | Two-pass heuristic classifier (title features + context boost) |
| `src/embeddings.ts` | ONNX embedding model, vector storage, cosine similarity, duplicate clustering |
| `src/query.ts` | `filterLinks`, sort/format helpers |
| `src/config.ts` | Collection registry, TOML merge, `Collection` class with computed paths |
| `src/paths.ts` | XDG base directory helpers |
| `src/mcp/server.ts` | MCP tool wiring (`query`, `find_similar`, `cluster`, `status`) |
| `src/ml-classifier.ts` | Optional Naive Bayes reclassifier for low-confidence records |
| `src/cli/qvoid.ts` | CLI dispatcher — hand-rolled argument parsing, command handlers |

## Pipeline Data Flow

```
vault .md files
  → walkVault()              [indexer.ts]  — file mtimes, resolvedStems
  → extractUnresolvedFromFile()            — parse AST, filter resolved targets
  → scanFile()                             — collect Occurrence objects per target
  → classifier.classify()   [classifier.ts]
  → writeJsonl()             [indexer.ts]  → unresolved_links.jsonl

(optional embedding step)
  → buildVectors()           [embeddings.ts] → vectors.bin + manifest.json

(query / MCP)
  → readJsonl() → filterLinks()  [query.ts]
  → findSimilar() / clusterDuplicates()  [embeddings.ts]
  → MCP tools                    [mcp/server.ts]
```

## Persistent Storage

| Path | Contents |
|---|---|
| `~/.config/qvoid/collections.toml` | Registry mapping collection names → vault paths |
| `~/.config/qvoid/collections/<name>.toml` | Per-collection config (TOML) |
| `~/.local/share/qvoid/<name>/unresolved_links.jsonl` | Link index — one `LinkRecord` JSON per line |
| `~/.local/share/qvoid/<name>/vectors.bin` | Flat Float32Array of all target embeddings |
| `~/.local/share/qvoid/<name>/manifest.json` | `VectorManifest` — model, dim, count, ordered target list |
| `~/.local/share/qvoid/<name>/scan_manifest.json` | File mtimes — drives incremental rebuild detection |

Paths are derived from `Collection` getters defined in `src/config.ts`; use those rather than constructing paths manually.

## Further Reading

- [DATA_MODEL.md](DATA_MODEL.md) — TypeScript interfaces and JSONL/vector formats
- [INDEXING.md](INDEXING.md) — Vault walk, parsing, incremental build
- [CLASSIFICATION.md](CLASSIFICATION.md) — Heuristic classifier decision tree
- [EMBEDDING.md](EMBEDDING.md) — Vector pipeline, similarity search, clustering
- [QUERYING.md](QUERYING.md) — Filtering, formatters, MCP tools
- [CONFIG.md](CONFIG.md) — TOML schema, merge rules, collection resolution
