# qvoid

Index, query, and dedup unresolved wikilinks across Obsidian-style vaults.

Solves two problems with unresolved links:

- **Noise** — every uncreated wikilink looks the same. `qvoid` classifies each target as `claim`, `concept`, `person`, `source`, `date`, `util`, or `unknown` and lets you filter by that class and by origin folder.
- **Inaccuracy** — each occurrence is enriched with the surrounding sentence and any inline semantic annotation (`Supports::`, `Related::`, `Jump::`, …). An embedding layer surfaces near-duplicate targets so you don't create two notes for the same idea.

## Install

```bash
git clone <this-repo> ~/GitProjects/qvoid
cd ~/GitProjects/qvoid
./install.sh
```

`install.sh` creates a project-local venv, installs dependencies (including `sentence-transformers` — one-time ~200 MB for torch), and drops a launcher at `~/.local/bin/qvoid`. Re-run it any time to upgrade in place.

Make sure `~/.local/bin` is on your `PATH`.

## Register a collection

```bash
qvoid init --name vault --path ~/GitProjects/Obsidian_Vault
```

This registers the collection in `~/.config/qvoid/collections.toml` and creates a per-collection config at `~/.config/qvoid/collections/vault.toml`. Edit that file to tune vault-specific settings (citation folders, semantic annotations, embedding model).

List collections:

```bash
qvoid collections
qvoid collections --remove vault
```

## Usage

With exactly one collection registered (or when you're inside the vault directory), `--collection` is inferred:

```bash
qvoid index                                      # build index + embeddings
qvoid index --no-embed                           # skip embeddings (faster, disables find-similar)
qvoid query --destination claim --origin Content/Claims
qvoid query --semantic-type Supports --format detailed
qvoid find-similar "seeing reality clearly" --top-k 5
qvoid find-similar --cluster --threshold 0.85
```

With multiple collections, pass `--collection <name>` or set `QVOID_COLLECTION=<name>`.

## Data layout

- Config: `~/.config/qvoid/collections.toml` + `~/.config/qvoid/collections/<name>.toml`
- Index:  `~/.local/share/qvoid/<name>/unresolved_links.jsonl`
- Vectors: `~/.local/share/qvoid/<name>/vectors.npy` + `manifest.json`

Nothing is written inside the vault itself.

## Collection config

Every field is optional; omitted keys fall back to the defaults below.

```toml
[source]
type = "obsidian"  # only supported source for now

[classifier]
# Folders whose unresolved links are overwhelmingly citations, not claims.
# Occurrences here without a semantic annotation get biased toward `source`.
citation_folders = [
    "Sources/Articles",
    "Sources/Journals",
    "Sources/Lectures",
    "Sources/Courses",
]

# Annotations that strongly imply the target is a claim.
claim_annotations = ["Supports", "Opposes", "Weakens", "Reminds"]

# Annotations that could be either claim or concept (title heuristic decides).
claim_or_concept_annotations = ["Jump", "Related", "Aka"]

[embeddings]
model = "sentence-transformers/all-MiniLM-L6-v2"
```

## Classifier

Two passes:

1. **Title heuristics** — `@name` → person, `YYYY-MM-DD` → date, ALL CAPS / `(2024)` / `et al.` → source, file extension or `/` in title → util, CamelCase → util, long sentence-case → claim, short title case → concept.
2. **Context boost** — inline annotations (`Supports::`, etc.) bias toward `claim`; occurrences in `citation_folders` without an annotation bias toward `source`. High-confidence title matches override the boost.

## Requirements

- Python 3.11+
- Obsidian with the [obsidian CLI](https://help.obsidian.md/cli) available on PATH (the `index` command calls `obsidian unresolved verbose format=json`)
