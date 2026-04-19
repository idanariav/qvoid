# Changelog

## [Unreleased]

## [0.1.0] - 2026-04-19

Initial release.

### Features

- **Filesystem indexing** — Reads `.md` files directly from disk; no external tools required. Incremental rescanning via mtime-based `scan_manifest.json`
- **6-type classifier** — Classifies each unresolved link target as `idea`, `person`, `date`, `file`, `template`, or `unknown` via a two-pass pipeline (title heuristics + context boost)
- **Configurable heuristics** — Each detection rule (`date`, `person`, `file_extensions`, `camelcase`, `template`, `capitalization`, `min_words_for_idea`) can be toggled per collection
- **Annotation-aware context** — Extracts inline semantic annotations (e.g. Dataview `Key::` fields) and scores each occurrence to upgrade classification confidence
- **Extension and type filters** — `exclude_extensions` drops targets with specific file suffixes before indexing; `exclude_types` drops entire classes after classification
- **Origin folder filter** — `origin_folders` restricts which vault folders are scanned for unresolved links
- **Embedding layer** — Generates sentence embeddings for all indexed targets and supports nearest-neighbour lookup and duplicate clustering via `find-similar`
- **Collection management** — `init`, `collections`, and `collection` commands manage per-vault TOML configs at `~/.config/qvoid/collections/<name>.toml`
- **Query interface** — `query` filters the index by destination type, origin folder, semantic annotation, occurrence count, and free-text search
