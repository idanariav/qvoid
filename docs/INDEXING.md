# Indexing Pipeline

**Entry point:** `buildIndex(vaultRoot, config, classifier, opts?)` in `src/indexer.ts`

Returns `LinkRecord[]` and writes `unresolved_links.jsonl` + `scan_manifest.json`.

## Phase 1 — Vault Walk

`walkVault(vaultRoot)` → `{ fileMtimes: Map<rel, mtime>, resolvedStems: Set<string> }`

- Uses `fast-glob` to discover all `**/*.md` files relative to `vaultRoot`
- Records `mtime` per file for incremental detection
- Builds `resolvedStems` — lowercase basenames without `.md` extension — used to identify which wikilink targets already have a file

## Phase 2 — Full vs Incremental Decision

`buildIndex` compares current `fileMtimes` against the saved `scan_manifest.json`:

- **Full build** (`fullBuild()`): no scan manifest exists, `--force` was passed, or `origin_folders` config changed. Scans every file.
- **Incremental build** (`incrementalBuild()`): scan manifest exists and vault config is unchanged. Identifies `staleSources` (added/modified/deleted files) and rescans only those.

## Phase 3 — Two-Pass Extraction

### Pass 1 — Unresolved target discovery

`extractUnresolvedFromFile(vaultRoot, relPath, resolvedStems, excludeExtensions)` is called for each file:

1. Reads file, calls `parseMarkdownAST(text)` → unified/remark MDAST with custom WikiLink nodes
2. Calls `extractWikiLinks(tree)` → `ParsedWikiLink[]`
3. Filters out targets that are resolved (match a `resolvedStem` or a literal file path) or have an excluded extension
4. Returns the list of unresolved target strings from that file

Result: `targetToSources: Map<target, Set<sourceFile>>` and `sourceToTargets: Map<sourceFile, Set<target>>`.

### Pass 2 — Occurrence collection

`scanFile(vaultRoot, relPath, targets, resolvedStems, excludeExtensions)` re-parses each source file that contains at least one relevant target:

- Calls `parseMarkdownAST` + `extractWikiLinks` again
- For each wikilink in `targets`, records an `Occurrence` with `source`, `source_folder`, `line`, `alias`, `semantic_type`
- Calls `extractContext(text, startOffset, endOffset)` → `{ context_before, context_after }` (200-char sentence windows)

## Phase 4 — Classification

For each unique unresolved target, `classifier.classify(target, occurrences)` is called once. Returns `[type, confidence, titleFeatures]` — stored in the `LinkRecord`. See [CLASSIFICATION.md](CLASSIFICATION.md).

## Incremental Delta Logic

`incrementalBuild` retains occurrences from unchanged files:

- Loads previous `LinkRecord[]` from JSONL
- Removes occurrences whose `source` is in `staleSources`
- Re-runs passes 1 & 2 only for stale files
- Merges new occurrences into existing records
- Re-classifies only targets whose occurrence set changed; unchanged targets keep their old `expected_destination` and `classification_confidence`

## Persistence

```typescript
writeJsonl(links: LinkRecord[], outPath: string): void  // one JSON per line
readJsonl(filePath: string): LinkRecord[]               // parses each line
```

Both in `src/indexer.ts`. Scan manifest is a plain JSON object mapping relative file paths to mtime numbers.

## Parser Details

`src/parser.ts` implements:

- **`parseMarkdownAST(text)`** — unified + remark-parse pipeline with two custom plugins:
  - micromark extension for `[[target]]`, `[[target|alias]]`, `[[target#section]]`
  - remark plugin for inline fields `(Key:: [[target]])` — captures `Key` as `semantic_type`
- **`extractWikiLinks(tree)`** — AST visitor that yields `ParsedWikiLink` objects with offsets
- **`extractContext(text, startOffset, endOffset)`** — character-offset window, respects sentence boundaries
