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

## Phase 3 — Single-Pass Extraction

`scanFileForUnresolvedLinks(vaultRoot, relPath, resolvedStems, excludeExtensions, isResolvedCache)` is called once per file (per candidate file in a full build, per changed file in an incremental build):

1. Reads file, calls `parseMarkdownAST(text)` → unified/remark MDAST with custom WikiLink nodes
2. Calls `extractWikiLinks(tree, text)` → `ParsedWikiLink[]`
3. For each link, skips excluded extensions and resolved targets (`isResolved`, memoized per build via `isResolvedCache` — a `Map<target, boolean>` — since the same target is often referenced from many files)
4. For the remaining unresolved links, calls `extractContext(text, startOffset, endOffset)` → `{ context_before, context_after }` (200-char sentence windows) and builds an `Occurrence` with `source`, `source_folder`, `line`, `alias`, `semantic_type`

Target discovery and occurrence collection happen from the same AST walk — each file is parsed exactly once. Results from all scanned files are merged into `occurrencesByTarget: Map<target, Occurrence[]>` via `mergeInto`.

## Phase 4 — Classification

For each unique unresolved target, `classifier.classify(target, occurrences)` is called once. Returns `[type, confidence, titleFeatures]` — stored in the `LinkRecord`. See [CLASSIFICATION.md](CLASSIFICATION.md).

## Incremental Delta Logic

`incrementalBuild` retains occurrences from unchanged files:

- Loads previous `LinkRecord[]` from JSONL
- Removes occurrences whose `source` is in `staleSources`
- Re-runs Phase 3 only for stale files
- Merges new occurrences into existing records
- Re-classifies only targets whose occurrence set changed; unchanged targets keep their old `expected_destination` and `classification_confidence`

`buildLinkRecords` (shared by both `fullBuild` and `incrementalBuild`) does the sort + classify + `excludeTypes` filter + `linkToRecord` step; `incrementalBuild` passes a `reuseClassification` callback so unchanged targets skip reclassification.

## Persistence

```typescript
writeJsonl(links: LinkRecord[], outPath: string): void  // one JSON per line
readJsonl(filePath: string): LinkRecord[]               // parses each line
```

Both in `src/indexer.ts`. Scan manifest is a plain JSON object mapping relative file paths to mtime numbers.

## Parser Details

`src/parser.ts` implements:

- **`parseMarkdownAST(text)`** — unified + remark-parse pipeline with three plugins:
  - `remark-frontmatter` — recognizes a leading `---`/YAML block as a single opaque node (`type: "yaml"`) instead of letting it fall through to generic block tokenization, where the leading `---` could be misparsed as a setext heading
  - micromark extension for `[[target]]`, `[[target|alias]]`, `[[target#section]]`
  - remark plugin for inline fields `(Key:: [[target]])` — captures `Key` as `semantic_type`
- **`extractWikiLinks(tree, fullText)`** — AST visitor that yields `ParsedWikiLink` objects with offsets. Body wikilinks come from walking `wikiLink` nodes; frontmatter wikilinks are recovered separately by regex-scanning the raw `yaml` node's text (the frontmatter block is never run through inline tokenization, so the micromark wikilink extension never sees inside it) and tagged with `semanticType: "frontmatter"`
- **`extractContext(text, startOffset, endOffset)`** — character-offset window, respects sentence boundaries
