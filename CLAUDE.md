# qvoid

Index, query, and deduplicate unresolved wikilinks across Obsidian-style vaults — with an MCP server for Claude Code.

## General instructions

When refactoring commands, for example renaming, adding/removing params - review the claude.md, relevant docs and README.md file to ensure no stale or outdated references remain.

## Commands

```sh
qvoid collection <name> --path <vault>  # Register a vault as a named collection
qvoid collections                       # List all registered collections
qvoid collections --remove <name>       # Remove a collection

qvoid index                             # Build / refresh link index (incremental by default)
qvoid index --force                     # Full rebuild, ignoring scan manifest
qvoid embed                             # Generate vector embeddings (required for find-similar)
qvoid embed --force                     # Rebuild all embeddings from scratch

qvoid query                             # List all unresolved links
qvoid query --destination idea          # Filter by type: idea | person | date | file | template | unknown
qvoid query --origin <folder>           # Filter by source folder prefix
qvoid query --semantic-type Supports    # Filter by inline annotation
qvoid query --min-occurrences 3         # Minimum occurrence count
qvoid query --search "term"             # Substring search on target name and context
qvoid query --format detailed           # Full context view (default: summary)
qvoid query --format json               # Raw JSON output

qvoid find-similar "query phrase"       # Semantic similarity search (requires embed)
qvoid find-similar --cluster            # Group near-duplicate targets into clusters
qvoid find-similar --cluster --threshold 0.85

qvoid classify                          # Reclassify low-confidence records using ML model
qvoid mcp                               # Start MCP server (stdio transport)
```

For all options see [README.md](README.md).

## Development

```sh
npm run qvoid -- <command>   # Run from source via tsx (no build needed)
npm run build                # Compile TypeScript → dist/
npm test                     # Run test suite (vitest)
```

## Important: Do NOT run automatically

- Never run `qvoid index`, `qvoid embed`, or `qvoid classify` automatically — these modify user data
- Write out example commands for the user to run manually
- Never modify JSONL or binary vector files directly

## Do NOT compile unnecessarily

- `npm run build` compiles TypeScript to `dist/` via `tsc -p tsconfig.build.json` and prepends a shebang to the CLI entry
- Use `npm run qvoid -- <command>` (tsx) during development to avoid repeated builds

## Releasing

Use `/npm-release` to cut a release.

- Add changelog entries under `## [Unreleased]` **as you make changes**
- The release script renames `[Unreleased]` → `[X.Y.Z] - date` at release time

## Architecture

See [docs/OVERVIEW.md](docs/OVERVIEW.md) for the full module map, pipeline data flow, and storage layout.

Subsystem docs:

| Topic | File |
|---|---|
| Data interfaces (Occurrence, LinkRecord, …) | [docs/DATA_MODEL.md](docs/DATA_MODEL.md) |
| Vault walk, parsing, incremental build | [docs/INDEXING.md](docs/INDEXING.md) |
| Two-pass heuristic classifier | [docs/CLASSIFICATION.md](docs/CLASSIFICATION.md) |
| Vector embeddings, similarity, clustering | [docs/EMBEDDING.md](docs/EMBEDDING.md) |
| filterLinks, formatters, MCP tools | [docs/QUERYING.md](docs/QUERYING.md) |
| TOML schema, collection resolution | [docs/CONFIG.md](docs/CONFIG.md) |
