import type { CollectionConfig } from "./config.js";
import type { Occurrence, TitleFeatures } from "./types.js";

const DATE_RE = /^\d{4}-\d{2}(-\d{2})?$|^\d{4}-W\d{2}$|^\d{4}-Q[1-4]$/;
const YEAR_IN_PARENS_RE = /\(\d{4}\)/;
const TEMPLATE_SYNTAX_RE = /<%|%>|\{\{|\}\}/;
const CAMELCASE_RE = /^[A-Z][a-z]+([A-Z][a-z]+)+$/;
const ET_AL_RE = /\bet\s+al\.?/i;
const FILE_EXT_RE = /\.\w+$/;
const VERB_RE = /\b(is|are|was|were|be|does|do|did|improves|boosts|affects|helps|makes|creates)\b/i;
const TITLE_CASE_WORD_RE = /^[A-Z][a-z]+$/;

export interface Heuristics {
  date: boolean;
  person: boolean;
  file_extensions: boolean;
  camelcase: boolean;
  template: boolean;
  // When true: ALL CAPS targets are classified as "unknown" (they're usually acronyms, not ideas)
  capitalization: boolean;
  // Minimum number of title-case words to classify as "idea" at medium confidence; 0 = disabled
  min_words_for_idea: number;
  // When true: targets containing a verb are classified as "idea" at high confidence
  verb_identification: boolean;
}

function heuristicsFromConfig(cc: CollectionConfig["classifier"]): Heuristics {
  const h = cc.heuristics;
  return {
    date: h.date,
    person: h.person,
    file_extensions: h.file_extensions,
    camelcase: h.camelcase,
    template: h.template,
    capitalization: h.capitalization,
    min_words_for_idea: h.min_words_for_idea,
    verb_identification: h.verb_identification,
  };
}

export function titleFeatures(target: string, personPrefix: string): TitleFeatures {
  const words = target.split(/\s+/).filter(Boolean);
  return {
    word_count: words.length,
    has_person_prefix: personPrefix.length > 0 && target.startsWith(personPrefix),
    is_date: DATE_RE.test(target.trim()),
    is_all_caps: target === target.toUpperCase() && /[a-zA-Z]/.test(target),
    is_short_camelcase: words.length === 1 && CAMELCASE_RE.test(target),
    has_year_in_parens: YEAR_IN_PARENS_RE.test(target),
    has_template_syntax: TEMPLATE_SYNTAX_RE.test(target),
    has_verb: VERB_RE.test(target),
    is_title_case_name: words.length >= 2 && words.length <= 3 && words.every(w => TITLE_CASE_WORD_RE.test(w)),
  };
}

function heuristicClass(target: string, feats: TitleFeatures, h: Heuristics): [string, string] {
  const t = target.trim();

  if (h.template && feats.has_template_syntax) return ["template", "high"];
  if (h.file_extensions && (FILE_EXT_RE.test(t) || t.includes("/"))) return ["file", "high"];
  if (h.person && feats.has_person_prefix) return ["person", "high"];
  if (h.person && feats.is_title_case_name) return ["person", "medium"];
  if (h.date && feats.is_date) return ["date", "high"];
  // Academic citation signals → always strong idea indicators
  if (feats.has_year_in_parens || ET_AL_RE.test(t)) return ["idea", "high"];
  // Verb in target → claim or statement worth capturing
  if (h.verb_identification && feats.has_verb) return ["idea", "high"];
  // ALL CAPS → almost certainly an acronym/abbreviation, not an idea
  if (h.capitalization && feats.is_all_caps) return ["unknown", "high"];
  if (h.camelcase && feats.is_short_camelcase) return ["file", "medium"];
  if (h.min_words_for_idea > 0 && feats.word_count >= h.min_words_for_idea && t[0] === t[0]?.toUpperCase() && t !== t.toUpperCase()) {
    return ["idea", "medium"];
  }
  if (feats.word_count >= 1) return ["idea", "low"];
  return ["unknown", "low"];
}

export class Classifier {
  private citationFolders: string[];
  private strongIdeaAnnotations: Set<string>;
  private weakIdeaAnnotations: Set<string>;
  private personPrefix: string;
  private heuristics: Heuristics;

  constructor(config: CollectionConfig) {
    const cc = config.classifier;
    this.citationFolders = [...cc.citation_folders];
    this.strongIdeaAnnotations = new Set(cc.strong_idea_annotations);
    this.weakIdeaAnnotations = new Set(cc.weak_idea_annotations);
    this.personPrefix = cc.person_prefix;
    this.heuristics = heuristicsFromConfig(cc);
  }

  private contextBoost(occurrences: Occurrence[]): number {
    let score = 0;
    for (const occ of occurrences) {
      if (occ.semantic_type && this.strongIdeaAnnotations.has(occ.semantic_type)) {
        score += 3;
      } else if (occ.semantic_type && this.weakIdeaAnnotations.has(occ.semantic_type)) {
        score += 1;
      }
      if (
        this.citationFolders.length > 0 &&
        this.citationFolders.some((sf) => occ.source_folder.startsWith(sf)) &&
        !occ.semantic_type
      ) {
        score += 1;
      }
    }
    return score;
  }

  classify(target: string, occurrences: Occurrence[]): [string, string, TitleFeatures] {
    const feats = titleFeatures(target, this.personPrefix);
    const [baseClass, baseConf] = heuristicClass(target, feats, this.heuristics);

    if (baseConf === "high") return [baseClass, baseConf, feats];

    const boost = this.contextBoost(occurrences);
    if (boost === 0) return [baseClass, baseConf, feats];
    if (boost >= 3) return ["idea", "high", feats];
    return ["idea", "medium", feats];
  }
}
