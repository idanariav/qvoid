# Classification

**File:** `src/classifier.ts`

## Entry Point

`new Classifier(config: CollectionConfig)` — constructor reads annotation lists, citation folders, person prefix, and heuristic toggles from `config.classifier`.

**`classify(target, occurrences)`** → `[type, confidence, TitleFeatures]`

Where `type` ∈ `"idea" | "person" | "date" | "file" | "template" | "unknown"` and `confidence` ∈ `"high" | "medium" | "low"`.

## Flow

```
titleFeatures(target, personPrefix)  →  TitleFeatures
  ↓
heuristicClass(target, feats, heuristics)  →  [baseClass, baseConf]
  ↓
if baseConf === "high"  →  return immediately (no context check)
  ↓
contextBoost(occurrences)  →  boost score
  boost === 0   →  return [baseClass, baseConf]
  boost 1–2     →  return ["idea", "medium"]
  boost ≥ 3     →  return ["idea", "high"]
```

## heuristicClass Priority Order

Rules are evaluated top-to-bottom; first match wins.

| Priority | Condition | Result |
|---|---|---|
| 1 | `has_template_syntax` (`<% %>`, `{{ }}`) | `template`, high |
| 2 | File extension or `/` in target | `file`, high |
| 3 | `has_person_prefix` (target starts with `@`) | `person`, high |
| 4 | `is_title_case_name` (2–3 title-case words) | `person`, medium |
| 5 | `is_date` (ISO 8601 patterns) | `date`, high |
| 6 | `has_year_in_parens` or contains `et al.` | `idea`, high |
| 7 | `has_verb` (is/are/improves/affects/…) | `idea`, high |
| 8 | `is_all_caps` | `unknown`, high |
| 9 | `is_short_camelcase` (single PascalCase word) | `file`, medium |
| 10 | `word_count >= min_words_for_idea` and starts uppercase | `idea`, medium |
| 11 | `word_count >= 1` | `idea`, low |
| 12 | (fallback) | `unknown`, low |

Each rule is individually gated by its corresponding heuristic toggle in config (e.g. `heuristics.date`, `heuristics.verb_identification`).

## contextBoost Scoring

Iterates `occurrences` and accumulates a score:

- `+3` — `semantic_type` is in `strong_idea_annotations` (default: `Supports`, `Opposes`, `Weakens`, `Reminds`)
- `+1` — `semantic_type` is in `weak_idea_annotations` (default: `Jump`, `Related`, `Aka`)
- `+1` — occurrence `source_folder` starts with a `citation_folder` and has no `semantic_type`

A single strong annotation is enough to reach `boost >= 3` and produce `["idea", "high"]`.

## Configuration

All behaviour is controlled through `config.classifier` (set in collection TOML):

| Key | Default | Effect |
|---|---|---|
| `strong_idea_annotations` | `["Supports","Opposes","Weakens","Reminds"]` | +3 boost per occurrence |
| `weak_idea_annotations` | `["Jump","Related","Aka"]` | +1 boost per occurrence |
| `citation_folders` | `[]` | +1 boost for unannotated links from these folders |
| `person_prefix` | `"@"` | Triggers rule 3 |
| `heuristics.min_words_for_idea` | `4` | Minimum word count for rule 10 |
| `heuristics.verb_identification` | `true` | Enable/disable rule 7 |
| `exclude_types` | `[]` | Drop records of these types after classification |

## Optional ML Classifier

`MlClassifier` in `src/ml-classifier.ts` wraps `wink-naive-bayes-text-classifier`.

- Only invoked from CLI `qvoid classify` for records with `classification_confidence === "low"`
- Model stored at `models/classifier.json`; training data at `models/training_data.json`
- Not part of the default `buildIndex` pipeline — must be triggered explicitly

## Adding a New Heuristic

Three touch points:

1. Add a boolean field to `TitleFeatures` in `src/types.ts`
2. Compute it in `titleFeatures()` in `src/classifier.ts`
3. Insert a rule into the priority chain in `heuristicClass()` in `src/classifier.ts`
