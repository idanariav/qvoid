# Configuration and Collections

**Files:** `src/config.ts`, `src/paths.ts`

## File Locations

All paths respect `XDG_CONFIG_HOME` / `XDG_DATA_HOME` environment variables, falling back to `~/.config` and `~/.local/share`.

| Path | Contents |
|---|---|
| `~/.config/qvoid/collections.toml` | Registry — maps collection names → vault paths |
| `~/.config/qvoid/collections/<name>.toml` | Per-collection config (TOML) |
| `~/.local/share/qvoid/<name>/` | All runtime data for the collection |

Path helpers are in `src/paths.ts`: `configDir()`, `dataDir()`, `registryPath()`, `collectionConfigPath(name)`, `collectionDataDir(name)`.

## Config Schema

`DEFAULT_CONFIG` in `src/config.ts` defines three sections:

### `[source]`
| Key | Default | Description |
|---|---|---|
| `origin_folders` | `[]` | Limit scanning to these folder prefixes; empty = whole vault |
| `exclude_extensions` | `[".jpg",".pdf",".mp4",…]` | File extensions to skip when checking link resolution |

### `[classifier]`
| Key | Default | Description |
|---|---|---|
| `exclude_types` | `[]` | Drop records of these types after classification |
| `citation_folders` | `[]` | Source folder prefixes that add +1 boost to idea classification |
| `strong_idea_annotations` | `["Supports","Opposes","Weakens","Reminds"]` | +3 boost per occurrence |
| `weak_idea_annotations` | `["Jump","Related","Aka"]` | +1 boost per occurrence |
| `person_prefix` | `"@"` | Prefix that signals a person wikilink |

#### `[classifier.heuristics]`
| Key | Default |
|---|---|
| `date` | `true` |
| `person` | `true` |
| `file_extensions` | `true` |
| `camelcase` | `true` |
| `template` | `true` |
| `capitalization` | `true` |
| `min_words_for_idea` | `4` |
| `verb_identification` | `true` |

### `[embeddings]`
| Key | Default | Description |
|---|---|---|
| `model` | `"Xenova/all-MiniLM-L6-v2"` | HuggingFace model name for `buildVectors` / `findSimilar` |

## Merge Behaviour

`mergeDefaults(userConfig)` in `src/config.ts` applies a shallow section-level merge:

- **Scalar values:** user value replaces default
- **Nested objects** (e.g. `classifier.heuristics`): shallow-merged one level deep
- **Arrays** (e.g. `strong_idea_annotations`): user array **replaces** default entirely — not appended

Consequence: to extend `exclude_extensions`, list all desired extensions in your TOML, including the defaults you want to keep.

## Collection Resolution

`resolveCollection(name?)` in `src/config.ts` — resolves a collection for CLI and MCP calls:

1. Use `name` if provided explicitly
2. Fall back to `QVOID_COLLECTION` environment variable
3. Check if CWD is inside a registered vault path
4. If exactly one collection is registered, use it
5. Otherwise throw — user must pass `--collection <name>`

## Key Functions

| Function | Description |
|---|---|
| `registerCollection(name, vaultPath)` | Adds to registry; writes default TOML if absent |
| `loadCollection(name)` | Reads registry + TOML, merges defaults, returns `Collection` |
| `resolveCollection(name?)` | Auto-resolve with fallback chain (see above) |
| `removeCollection(name)` | Removes from registry only; data directory is preserved |
| `updateCollectionConfig(name, section, updates)` | Partial section update — used internally by CLI config commands |
| `listCollections()` | Returns registry as `Record<name, { path }>` |
