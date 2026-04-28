# Querying and MCP

## filterLinks

**`filterLinks(links: LinkRecord[], opts: FilterOpts): LinkRecord[]`** in `src/query.ts`

All filter fields are optional; unset fields are skipped. Filters are AND-combined.

**Sort order:** `total_occurrences DESC`, then `target ASC` (alphabetical tiebreaker). `opts.limit` is applied after sorting.

### FilterOpts Fields

| Field | Matches against | Match function |
|---|---|---|
| `origin` | Any `occ.source.startsWith(origin)` | `matchOrigin()` |
| `destination` | `link.expected_destination` | exact equality |
| `semanticType` | Any `occ.semantic_type === semanticType` | `matchSemantic()` |
| `minOccurrences` | `link.stats.total_occurrences >= minOccurrences` | threshold |
| `search` | `link.normalized` or any `occ.context_before/after` | `matchSearch()` — case-insensitive substring |
| `limit` | result slice | post-sort |

Valid `destination` values: `"idea"`, `"person"`, `"date"`, `"file"`, `"template"`, `"unknown"`.

## Output Formatters

Both in `src/query.ts`:

- **`formatSummary(links)`** — fixed-width table: `count | class | conf | target`
- **`formatDetailed(links)`** — per-link block showing every occurrence with `source:line`, `[semantic_type]`, alias, and surrounding context

## CLI

`cmdQuery` in `src/cli/qvoid.ts` parses flags and maps them to `FilterOpts`:

| Flag | FilterOpts field |
|---|---|
| `--origin <prefix>` | `origin` |
| `--destination <type>` | `destination` |
| `--semantic-type <key>` | `semanticType` |
| `--min-occurrences <n>` | `minOccurrences` |
| `--search <term>` | `search` |
| `--limit <n>` | `limit` |
| `--format summary\|detailed\|json` | selects formatter or raw JSON output |

## MCP Server

**File:** `src/mcp/server.ts` — uses `@modelcontextprotocol/sdk`, `StdioServerTransport`.

### Tools

| Tool | Core function | Returns |
|---|---|---|
| `query` | `filterLinks()` | `LinkRecord[]` as JSON |
| `find_similar` | `findSimilar()` from `embeddings.ts` | `{ target, score }[]` as JSON |
| `cluster` | `clusterDuplicates()` from `embeddings.ts` | `string[][]` as JSON |
| `status` | `readJsonl()` + inline aggregation | counts by `expected_destination` and `classification_confidence` |

**Collection resolution** for all tools: `resolveCollection(args.collection?)` in `src/config.ts` — falls back to `QVOID_COLLECTION` env var, then CWD match, then single-collection shortcut. See [CONFIG.md](CONFIG.md).

### MCP Input Schemas

- `query` — accepts: `collection`, `destination`, `origin`, `semantic_type`, `min_occurrences`, `search`, `limit`
- `find_similar` — accepts: `query`, `collection`, `top_k`, `min_score`
- `cluster` — accepts: `collection`, `threshold`
- `status` — accepts: `collection`

## Extending the Query Layer

To add a new filter dimension, change three places:

1. `FilterOpts` interface in `src/query.ts`
2. Filter chain in `filterLinks()` in `src/query.ts`
3. `inputSchema` + handler in `src/mcp/server.ts` (and optionally `cmdQuery` in CLI)
