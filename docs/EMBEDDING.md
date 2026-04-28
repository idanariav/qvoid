# Embedding Pipeline

**File:** `src/embeddings.ts`

## Entry Point

`buildVectors(links, vectorsPath, manifestPath, modelName, onProgress?)` — called by `cmdEmbed` in `src/cli/qvoid.ts` after loading the JSONL index.

## Document Text Construction

`documentText(link: LinkRecord)` — builds the string that gets encoded per target:

```
target | context_before [[...]] context_after (semantic_type) | …
```

- Includes up to 5 occurrences
- Each occurrence contributes a context snippet and an optional `(semantic_type)` label
- Parts joined with ` | `

This means targets with richer occurrence context get more informative embeddings.

## Model

- **Name:** `Xenova/all-MiniLM-L6-v2` (default; configurable via `embeddings.model` in TOML)
- **Dimension:** 384
- **Format:** ONNX, ~25 MB, downloaded once from HuggingFace Hub
- **Runtime:** `@huggingface/transformers` with `HF_HUB_OFFLINE=1` — never fetches after first download
- **Loaded by:** `loadModel(modelName)` — module-level cached; only one pipeline instance at a time

Encoding options: `pooling: "mean"`, vectors L2-normalized before storage.

## Incremental Behaviour

`buildVectors` checks the existing `manifest.json`:

- If the model name matches, loads existing `vectors.bin` and skips already-embedded targets
- Only encodes targets not present in the current manifest
- Merges new vectors with retained ones before writing
- Force rebuild (`--force`): deletes `vectors.bin` and `manifest.json` first

Batch size: **64** documents per encoding call.

## Storage Format

**`vectors.bin`** — flat binary `Float32Array`, row-major:
- Row `i` = bytes `[i * dim * 4, (i+1) * dim * 4)`
- Total size = `count * dim * 4` bytes

**`manifest.json`** — `VectorManifest`:
```typescript
{ model: string, dim: number, count: number, order: string[] }
```
`order[i]` is the target string for row `i`. Use `order.indexOf(target)` to look up a vector.

## Similarity Search

`findSimilar(query, vectorsPath, manifestPath, opts?)` in `src/embeddings.ts`:

1. Loads vectors and manifest from disk
2. If `query` matches an existing `order` entry → reuses its stored vector (no re-encoding)
3. Otherwise encodes `query` on-the-fly using the loaded model
4. Computes `dotProduct(queryVec, targetVec)` for all targets — equals cosine similarity because vectors are pre-normalized
5. Sorts descending, excludes the query target itself
6. Returns top-`topK` results above `minScore` threshold as `{ target: string, score: number }[]`

Default opts: `topK = 10`, `minScore = 0.0`.

## Duplicate Clustering

`clusterDuplicates(vectorsPath, manifestPath, threshold?)` in `src/embeddings.ts`:

- **Algorithm:** union-find over all target pairs
- **Similarity threshold:** default `0.82`
- **Chunking:** processes 256 vectors at a time to limit memory pressure
- **Returns:** `string[][]` — groups of 2+ near-duplicate targets, sorted by cluster size descending

## Key Functions

| Function | Location | Purpose |
|---|---|---|
| `buildVectors` | `embeddings.ts` | Orchestrate encoding + storage |
| `documentText` | `embeddings.ts` | Format a LinkRecord into encodable text |
| `loadModel` | `embeddings.ts` | Lazy-load + cache the HF pipeline |
| `findSimilar` | `embeddings.ts` | Cosine similarity search |
| `clusterDuplicates` | `embeddings.ts` | Union-find duplicate clustering |
| `dotProduct` | `embeddings.ts` | Inner product of two Float32Arrays |
