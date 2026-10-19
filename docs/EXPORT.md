# Portable export (`qvoid export`)

Writes a compact copy of a collection's link index and vectors into a vault folder, so clients
that can't run qvoid (the pkm-rag plugin on mobile, or a desktop without qvoid) can still run
`query` and `find-similar`. Target vectors are read from qvoid's own `vectors.bin`, not re-embedded. Only the
word table (below) is embedded.

```sh
qvoid export --out <vault>/Scaffolding/Embeddings/qvoid   # explicit (relative to cwd)
qvoid export                                              # uses [export] path
```

Collection TOML. When `path` is set, `qvoid index` and `qvoid embed` re-export at the end:

```toml
[export]
path = "Scaffolding/Embeddings/qvoid"   # relative to the vault, or absolute
```

## Format: `pkm-vectors` v2

Same layout as `qmd export`, plus the records file:

- `records.jsonl` is a byte copy of `unresolved_links.jsonl`, so `filterLinks` / `projectFields`
  (published as `@idan_ariav/qvoid/query`) run on it unchanged.
- `vectors-0.bin`, `vectors-1.bin`, … are int8, row-major, `dim` bytes per row: all `items` first, then all `words`, split on row boundaries into files of at most 4 MiB (Obsidian Sync's Standard plan skips files over 5 MB). Concatenate the files in manifest `files` order. Format v1 (before qmd 2.6 / qvoid 0.6 / qimg 0.5) wrote one `vectors.bin` and had no `files`; readers should accept both.
- `manifest.json`:

```jsonc
{
  "format": "pkm-vectors", "version": 2, "tool": "qvoid", "collection": "vault",
  "model": "Xenova/bge-small-en-v1.5", "dim": 384, "scale": 127,
  "exportedAt": "<ISO date>",
  "files": ["vectors-0.bin", "vectors-1.bin"],
  "items": ["<target>", "…"],   // embedded targets (embeddings.classes), in vector-row order
  "words": ["ability", "…"]
}
```

Vectors keep the model's full dimensions (bge-small isn't trained for truncation), L2-normalized,
then `round(x * 127)`. The similarity of two rows is `dot(a, b) / 127²`.

**Word table.** A free-text `find-similar` query is embedded as the mean of its words' vectors, and a
query that is itself a target uses that target's row. The table holds `assets/common-words.txt`
(~5k English words), every target word, and every word used at least 3 times across link contexts
and the notes under `source.origin_folders` (text after a note's `%%` drawing-data line is ignored).
Words are embedded raw, the way `findSimilar` embeds a query. They're reused from the previous export
while the model and dim are unchanged.

**Fidelity** (vault collection, 780 targets):
- `find-similar`: on the 15 single-noun queries in pkm-smart-link's `eval/queries.json`, the lite
  top-10 shares 9.3/10 targets with `qvoid find-similar` on average. Multi-word queries are weaker
  ("resistance to change": 6/10), as expected from averaging word vectors.
- `--cluster` at 0.82: 45 of the CLI's 46 clusters are reproduced exactly. The one difference is a
  pair right at the threshold, flipped by int8 rounding.
