export interface Occurrence {
  source: string;
  source_folder: string;
  line: number;
  alias?: string;
  semantic_type?: string;
  context_before: string;
  context_after: string;
}

export interface TitleFeatures {
  word_count: number;
  has_person_prefix: boolean;
  is_date: boolean;
  is_all_caps: boolean;
  is_short_camelcase: boolean;
  has_year_in_parens: boolean;
  has_template_syntax: boolean;
}

export interface UnresolvedLink {
  target: string;
  normalized: string;
  expected_destination: string;
  classification_confidence: string;
  title_features: TitleFeatures;
  occurrences: Occurrence[];
}

export interface LinkStats {
  total_occurrences: number;
  unique_source_folders: number;
  semantic_types: string[];
}

export interface LinkRecord extends UnresolvedLink {
  stats: LinkStats;
}

export function linkToRecord(link: UnresolvedLink): LinkRecord {
  return {
    ...link,
    stats: {
      total_occurrences: link.occurrences.length,
      unique_source_folders: new Set(link.occurrences.map((o) => o.source_folder)).size,
      semantic_types: [...new Set(link.occurrences.map((o) => o.semantic_type).filter(Boolean) as string[])].sort(),
    },
  };
}
