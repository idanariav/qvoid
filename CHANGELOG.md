# Changelog

## [Unreleased]

## [0.3.1] - 2026-05-23

### Fixed
- **Wikilink target parsing** — Replaced `buffer()`/`resume()` with `sliceSerialize()` to correctly capture wikilink target text; the previous approach silently read every target as an empty string due to `wikiLinkData` not being registered with `onenterdata` in mdast-util-from-markdown v2
- **Ghost records in index output** — Targets whose occurrences are fully removed (deleted or modified source files) were still written as zero-occurrence `LinkRecord`s; they are now dropped, keeping the "Wrote N records" count accurate

## [0.3.0] - 2026-05-02

### Added
- **OR destination filter** — `--destination` now accepts comma-separated types (`idea,unknown`) for CLI and an array via MCP, matching any of the listed types
- **Alias-aware search** — `--search` now matches against wikilink aliases (e.g. `[[John Doe|John]]` is found by searching "John")
- **Auto ML classification on index** — `qvoid index` automatically applies the trained Naive Bayes classifier to low-confidence records when a model is available, without a separate `qvoid classify` step

### Changed
- **Default embedding model upgraded** — Changed from `all-MiniLM-L6-v2` to `bge-small-en-v1.5` for measurably better retrieval accuracy at the same 384-dim footprint. Existing vector indexes built with the old model will be automatically rebuilt on the next `qvoid embed`
- **AST-based wikilink parser** — Replaced regex-based parsing with a unified/remark AST pipeline (`src/parser.ts`); semantic type resolution is now structural rather than a line-window heuristic, improving accuracy for long field names and multi-wikilink inline fields. Removes `annotation_pattern` from the TOML config (no longer needed)
- **Annotation config keys renamed** — `claim_annotations` → `strong_idea_annotations` and `claim_or_concept_annotations` → `weak_idea_annotations` in the `[classifier]` TOML section. Update your collection config if you customized these keys

## [0.2.0] - 2026-04-25

### Added
- **ML classifier step** — Low-confidence index entries now pass through a Naive Bayes text classifier for improved type accuracy
- **Short capitalized links as `person`** — Single capitalized words are now recognized as likely person references
- **Force flag for `index` and `embed`** — `--force` option re-processes all entries, bypassing incremental caching
- **Progress bar** — `index` and `embed` commands now display a progress bar during processing
- **Verb classification** — Verb-form link targets are now classified and handled appropriately
- **Marketplace config** — Added Claude Code MCP integration metadata and marketplace entry

### Changed
- **`collection` command consolidates `init`** — The `init` subcommand is now merged into `collection`; use `qvoid collection <name>` to create or manage collections
- **Smarter incremental embedding** — Embedding now only processes new or modified links, reducing re-run cost

### Fixed
- Embedding pipeline error when processing certain link shapes

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
