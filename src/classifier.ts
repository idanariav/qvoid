import type { CollectionConfig } from "./config.js";
import type { Occurrence, TitleFeatures } from "./types.js";

const DATE_RE = /^\d{4}-\d{2}(-\d{2})?$|^\d{4}-W\d{2}$|^\d{4}-Q[1-4]$/;
const YEAR_IN_PARENS_RE = /\(\d{4}\)/;
const TEMPLATE_SYNTAX_RE = /<%|%>|\{\{|\}\}/;
const CAMELCASE_RE = /^[A-Z][a-z]+([A-Z][a-z]+)+$/;
const ET_AL_RE = /\bet\s+al\.?/i;
const FILE_EXT_RE = /\.\w+$/;

export interface Heuristics {
  date: boolean;
  person: boolean;
  file_extensions: boolean;
  camelcase: boolean;
  template: boolean;
  capitalization: boolean;
  min_words_for_idea: number;
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
  };
}

function heuristicClass(target: string, feats: TitleFeatures, h: Heuristics): [string, string] {
  const t = target.trim();

  if (h.template && feats.has_template_syntax) return ["template", "high"];
  if (h.file_extensions && (FILE_EXT_RE.test(t) || t.includes("/"))) return ["file", "high"];
  if (h.person && feats.has_person_prefix) return ["person", "high"];
  if (h.date && feats.is_date) return ["date", "high"];
  if (h.capitalization && (feats.is_all_caps || feats.has_year_in_parens || ET_AL_RE.test(t))) {
    return ["idea", "high"];
  }
  if (h.camelcase && feats.is_short_camelcase) return ["file", "medium"];
  if (h.min_words_for_idea > 0 && feats.word_count >= h.min_words_for_idea && t[0] === t[0]?.toUpperCase() && t !== t.toUpperCase()) {
    return ["idea", "medium"];
  }
  if (feats.word_count >= 1) return ["idea", "low"];
  return ["unknown", "low"];
}

export class Classifier {
  private citationFolders: string[];
  private claimAnnotations: Set<string>;
  private ideaAnnotations: Set<string>;
  private personPrefix: string;
  private heuristics: Heuristics;

  constructor(config: CollectionConfig) {
    const cc = config.classifier;
    this.citationFolders = [...cc.citation_folders];
    this.claimAnnotations = new Set(cc.claim_annotations);
    this.ideaAnnotations = new Set(cc.claim_or_concept_annotations);
    this.personPrefix = cc.person_prefix;
    this.heuristics = heuristicsFromConfig(cc);
  }

  private contextBoost(occurrences: Occurrence[]): number {
    let score = 0;
    for (const occ of occurrences) {
      if (occ.semantic_type && this.claimAnnotations.has(occ.semantic_type)) {
        score += 3;
      } else if (occ.semantic_type && this.ideaAnnotations.has(occ.semantic_type)) {
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
