# qvoid

Index, query, and dedup unresolved wikilinks across Obsidian-style vaults.

Solves two problems with unresolved links:

- **Noise** — every uncreated wikilink looks the same. `qvoid` classifies each target as `idea`, `person`, `date`, `file`, `template`, or `unknown`, and lets you filter by type, origin folder, and annotation.
- **Inaccuracy** — each occurrence is enriched with the surrounding sentence and any inline semantic annotation (`Supports::`, `Related::`, `Jump::`, …). An embedding layer surfaces near-duplicate targets so you don't create two notes for the same idea.

## Install

```bash
npm install -g @idan_ariav/qvoid
```

Requires Node.js 22+. The embedding model (`all-MiniLM-L6-v2` ONNX, ~25 MB) is downloaded on first use of `qvoid embed` or `qvoid find-similar`.

## MCP server (Claude Code)

Add to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "qvoid": { "command": "qvoid", "args": ["mcp"] }
  }
}
```

This exposes four tools: `query`, `find_similar`, `cluster`, `status`.

## Quickstart

```bash
# 1. Register your vault
qvoid collection vault --path ~/my-vault

# 2. Build the index
qvoid index

# 4. Query
qvoid query --destination idea
qvoid query --destination idea --min-occurrences 2 --format detailed

# 5. Find near-duplicates
qvoid embed
qvoid find-similar --cluster
```

## Commands

### `collections`

List or remove registered collections:

```bash
qvoid collections
qvoid collections --remove vault
```

### `collection`

Register a vault as a named collection, or view its current settings:

```bash
qvoid collection vault --path ~/my-vault   # register (creates ~/.config/qvoid/collections/vault.toml)
qvoid collection vault                     # show current settings
```

### `index`

Build or refresh the link index:

```bash
qvoid index
qvoid index --collection vault   # explicit collection name
```

Reads `.md` files directly — no external tools required. Subsequent runs are **incremental**: only files whose modification time changed since the last run are rescanned. Links whose target `.md` file has since been created are automatically dropped.

### `embed`

Build embeddings from the current index (required for `find-similar`):

```bash
qvoid embed
```

### `query`

Filter the index by type, origin folder, annotation, or free-text search:

```bash
qvoid query --destination idea
qvoid query --destination idea --origin Sources/Articles
qvoid query --destination idea --min-occurrences 3 --format detailed
qvoid query --semantic-type Supports --format detailed
qvoid query --search "cognitive bias" --limit 20
qvoid query --format json | jq '.target'
```

| Flag | Description |
|---|---|
| `--destination` | Filter by type: `idea`, `person`, `date`, `file`, `template`, `unknown` |
| `--origin` | Source path prefix (e.g. `Sources/Articles`) |
| `--semantic-type` | Match a specific inline annotation (e.g. `Supports`) |
| `--min-occurrences` | Minimum number of occurrences across the vault |
| `--search` | Substring match on target name or surrounding context |
| `--limit` | Cap result count |
| `--format` | `summary` (default), `detailed`, or `json` |

### `find-similar`

Find semantically similar unresolved targets using embeddings:

```bash
qvoid find-similar "seeing reality clearly" --top-k 5
qvoid find-similar --cluster                     # group suspected duplicates
qvoid find-similar --cluster --threshold 0.85    # stricter clustering
```

Run `qvoid embed` first.

## Types

| Type | Meaning | Primary signals |
|---|---|---|
| `idea` | A concept, claim, or source worth capturing as a note | word count, capitalization, annotation context |
| `person` | A person link | configurable prefix (default `@`) |
| `date` | A date reference | ISO date, week, quarter patterns |
| `file` | A resource link, not a note | file extension, `/` in target, CamelCase |
| `template` | A template artifact | `<% %>`, `{{ }}` syntax |
| `unknown` | Could not classify | fallback |

## Classifier

Two passes:

1. **Title heuristics** — structural signals (person prefix, ISO date, file extension, template syntax) are high-confidence and always respected. Capitalization patterns (ALL-CAPS, year in parens, et al.) signal a high-confidence idea. Word count provides a medium/low-confidence idea baseline. Each heuristic can be toggled via `[classifier.heuristics]`.
2. **Context boost** — inline annotations (`Supports::` etc., pattern configurable) score each occurrence. Score ≥ 3 → high-confidence idea; score ≥ 1 → medium. High-confidence title matches are never overridden.

## Data layout

All data lives outside the vault:

- Config: `~/.config/qvoid/collections/<name>.toml`
- Index: `~/.local/share/qvoid/<name>/unresolved_links.jsonl`
- Scan manifest: `~/.local/share/qvoid/<name>/scan_manifest.json`
- Vectors: `~/.local/share/qvoid/<name>/vectors.npy` + `manifest.json`

## Collection config

Every field is optional; omitted keys fall back to the defaults shown below.

```toml
[source]
# Regex with one capture group matching the annotation name before a wikilink.
# Default: Dataview inline-field syntax — (Key:: [[target]]
# Set to "" to disable annotation extraction.
annotation_pattern = '\(([A-Za-z]+)::\s*$'

# Targets with these extensions are excluded before indexing.
# Remove entries to allow them through; add entries to block more.
exclude_extensions = [
    ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp",
    ".excalidraw", ".pdf", ".mp4", ".mov", ".mp3", ".wav", ".zip",
]

[classifier]
# Drop links classified as these types from the index entirely.
# Valid values: idea, person, date, file, template, unknown
exclude_types = []

# Folders whose unannotated occurrences add +1 to the idea confidence score.
citation_folders = []

# Inline annotations and their confidence boost.
claim_annotations = ["Supports", "Opposes", "Weakens", "Reminds"]  # +3
claim_or_concept_annotations = ["Jump", "Related", "Aka"]           # +1

# Prefix that marks a person link (e.g. "@Alice"). Set to "" to disable.
person_prefix = "@"

[classifier.heuristics]
# Toggle individual detection rules. Partial overrides are merged with defaults.
date = true             # ISO date/week/quarter patterns → date
person = true           # person_prefix links → person
file_extensions = true  # targets with a file extension or "/" → file
camelcase = true        # CamelCase single words → file (medium confidence)
template = true         # template syntax → template
capitalization = true   # ALL-CAPS, (YEAR), et al. → high-confidence idea
min_words_for_idea = 4  # ≥ N title-case words → medium-confidence idea; 0 = disabled

[embeddings]
model = "sentence-transformers/all-MiniLM-L6-v2"
```

## Requirements

- Node.js 22+
- No external tools required — `qvoid index` reads `.md` files directly from disk.
