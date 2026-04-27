# qvoid

Index, query, and deduplicate unresolved wikilinks across Obsidian-style vaults — with an MCP server for Claude Code.

---

## Quick Start

### Install

**Via npm:**

```bash
npm install -g @idan_ariav/qvoid
```

**Via Claude Marketplace:**

```bash
claude plugin marketplace add idanariav/pkm-query-tools
claude plugin install qvoid@pkm-query-tools
```

Then verify the MCP server is running with `/mcp list` — you should see `qvoid` in the list.

### First Run

```bash
# Register your vault
qvoid collection vault --path ~/my-vault

# Build the link index
qvoid index

# Ask Claude to help you manage your vault
```

### Popular Commands

```bash
# See all unresolved idea-type links
qvoid query --destination idea

# Find near-duplicate link targets (requires embed step)
qvoid embed
qvoid find-similar --cluster

# Detailed view with surrounding context
qvoid query --destination idea --min-occurrences 2 --format detailed

# Search by keyword across target names and contexts
qvoid query --search "cognitive bias"
```

---

## Use Cases

qvoid helps you manage the hidden layer of your knowledge base — the links that point to notes that don't exist yet. These unresolved wikilinks accumulate over time and are hard to reason about manually.

**Questions qvoid can help you answer:**

- *What ideas have I referenced the most but never written a note for?* — Use `query --destination idea --min-occurrences 3` to surface high-frequency unresolved concepts.
- *Are there duplicate ideas in my vault under different names?* — Use `find-similar --cluster` to detect near-duplicate link targets before creating notes.
- *Which people have I referenced across my notes?* — Use `query --destination person` to see all person-type wikilinks.
- *What topics from my reading notes are still unexplored?* — Use `query --origin Sources/Articles --destination idea` to filter by source folder and type.
- *Which unresolved links are supported by strong semantic context?* — Use `query --semantic-type Supports` to find links annotated with inline claim annotations.
- *What's the overall state of my unresolved links?* — Ask Claude directly via the MCP server: *"Summarize my unresolved links and suggest which ones to write first."*

---

## Commands

### `collection`

Register a vault as a named collection, or inspect its current settings:

```bash
qvoid collection vault --path ~/my-vault   # register (saves to ~/.config/qvoid/collections/vault.toml)
qvoid collection vault                     # show current settings
```

### `collections`

List all registered collections, or remove one:

```bash
qvoid collections
qvoid collections --remove vault
```

### `index`

Build or refresh the link index. Reads `.md` files directly — no external tools required. Subsequent runs are **incremental**: only files modified since the last run are rescanned. Links whose target file has since been created are automatically dropped.

```bash
qvoid index
qvoid index --collection vault   # target a specific collection
```

### `embed`

Build vector embeddings from the current index. Required before running `find-similar`. Downloads the embedding model (~25 MB) on first use.

```bash
qvoid embed
```

### `query`

Filter and search the index by type, folder, annotation, or free text:

```bash
# Filter by link type
qvoid query --destination idea
qvoid query --destination person

# Filter by source folder
qvoid query --destination idea --origin Sources/Articles

# Require a minimum number of occurrences
qvoid query --destination idea --min-occurrences 3

# Filter by inline semantic annotation
qvoid query --semantic-type Supports

# Keyword search across target names and surrounding context
qvoid query --search "cognitive bias" --limit 20

# Output as JSON for scripting
qvoid query --format json | jq '.target'

# Detailed view with surrounding sentences
qvoid query --destination idea --format detailed
```

| Flag | Description |
|---|---|
| `--destination` | Filter by type: `idea`, `person`, `date`, `file`, `template`, `unknown` |
| `--origin` | Source folder prefix (e.g. `Sources/Articles`) |
| `--semantic-type` | Match a specific inline annotation (e.g. `Supports`, `Opposes`) |
| `--min-occurrences` | Minimum number of times the target appears across the vault |
| `--search` | Substring match on target name or surrounding context |
| `--limit` | Cap the number of results |
| `--format` | `summary` (default), `detailed`, or `json` |

### `find-similar`

Find semantically similar unresolved link targets using vector embeddings. Useful for detecting duplicates before creating new notes.

```bash
# Find links similar to a query phrase
qvoid find-similar "seeing reality clearly" --top-k 5

# Group suspected duplicates into clusters
qvoid find-similar --cluster

# Use a stricter similarity threshold
qvoid find-similar --cluster --threshold 0.85
```

Run `qvoid embed` before using this command.

---

## Methodology

qvoid processes your vault in three stages:

### 1. Indexing

The indexer scans every `.md` file in the registered vault, extracts all `[[wikilinks]]`, and checks which ones do not resolve to an existing file. For each unresolved target, it records:

- The target name
- The file it appeared in (origin)
- The surrounding sentence for context
- Any inline semantic annotation (e.g. `Supports::`, `Related::`) captured by a configurable regex pattern

Runs are incremental — a scan manifest tracks file modification times so only changed files are reprocessed.

### 2. Classification

Each unresolved link target is classified into one of six types using a two-pass heuristic system:

**Pass 1 — Title heuristics:** Structural signals are evaluated first: person prefixes (`@`), ISO date patterns, file extensions, CamelCase, and template syntax. These are high-confidence and are never overridden. Word count and capitalization patterns (ALL-CAPS, year in parentheses, title-case phrases) provide medium-confidence idea signals.

**Pass 2 — Context boost:** Inline annotations from each occurrence contribute a confidence score. Strong idea annotations like `Supports` and `Opposes` add +3; weak idea annotations like `Related` and `Jump` add +1. If the accumulated score reaches the idea threshold, the type is upgraded accordingly.

| Type | Meaning |
|---|---|
| `idea` | An unresolved link worth capturing as a note |
| `person` | A person reference (matched by configurable prefix, default `@`) |
| `date` | A date reference (ISO date, week, or quarter patterns) |
| `file` | A resource link, not a note (file extension, `/` in path, CamelCase) |
| `template` | A template artifact (`<% %>`, `{{ }}` syntax) |
| `unknown` | Could not be classified — fallback |

### 3. Embedding and Similarity

When you run `qvoid embed`, each unique unresolved target is encoded into a dense vector using the `all-MiniLM-L6-v2` ONNX model (~25 MB, downloaded once). These vectors are stored locally alongside the index.

`find-similar` uses cosine similarity to surface targets that are semantically close — either to a query phrase or to each other (clustering mode). This lets you catch duplicates like `"mental models"` and `"thinking frameworks"` before creating redundant notes.

---

## Privacy and Security

qvoid runs entirely on your device. No data ever leaves your machine.

- **No cloud indexing** — the vault scanner reads files directly from disk.
- **No remote API calls** — the embedding model (`all-MiniLM-L6-v2`) runs locally via ONNX Runtime.
- **No telemetry** — nothing is phoned home.
- **Data stays local** — the index, vectors, and config are all written to standard local directories (`~/.config/qvoid/`, `~/.local/share/qvoid/`), never synced externally.

You can point qvoid at any vault, including private journals or sensitive work notes, without concern.

---

## Other Plugins

qvoid is part of the **pkm-query-tools** marketplace — a suite of local, offline MCP plugins for knowledge management:

| Plugin | Description |
|---|---|
| **qnode** | Graph traversal over your vault's link structure. Explore neighbors, paths, and clusters of connected notes. |
| **qimg** | Search and retrieve images from your vault using semantic similarity. |

Install the full suite:

```bash
claude plugin marketplace add idanariav/pkm-query-tools
claude plugin install qnode@pkm-query-tools
claude plugin install qimg@pkm-query-tools
```
