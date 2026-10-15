import type { LinkRecord } from "./types.js";

export interface FilterOpts {
  origin?: string;
  destination?: string | string[];
  semanticType?: string;
  minOccurrences?: number;
  search?: string;
  limit?: number;
}

export function matchOrigin(link: LinkRecord, origin: string): boolean {
  return link.occurrences.some((o) => o.source.startsWith(origin));
}

export function matchSemantic(link: LinkRecord, semantic: string): boolean {
  return link.occurrences.some((o) => o.semantic_type === semantic);
}

export function matchSearch(link: LinkRecord, q: string): boolean {
  const ql = q.toLowerCase();
  if (link.normalized.includes(ql)) return true;
  return link.occurrences.some(
    (o) =>
      (o.alias !== undefined && o.alias.toLowerCase().includes(ql)) ||
      o.context_before.toLowerCase().includes(ql) ||
      o.context_after.toLowerCase().includes(ql),
  );
}

export function filterLinks(links: LinkRecord[], opts: FilterOpts): LinkRecord[] {
  let results = links.filter((link) => {
    if (opts.origin && !matchOrigin(link, opts.origin)) return false;
    if (opts.destination) {
      const dests = Array.isArray(opts.destination) ? opts.destination : [opts.destination];
      if (!dests.includes(link.expected_destination)) return false;
    }
    if (opts.semanticType && !matchSemantic(link, opts.semanticType)) return false;
    if (opts.minOccurrences !== undefined && link.stats.total_occurrences < opts.minOccurrences) return false;
    if (opts.search && !matchSearch(link, opts.search)) return false;
    return true;
  });

  results.sort((a, b) => b.stats.total_occurrences - a.stats.total_occurrences || a.target.localeCompare(b.target));
  if (opts.limit !== undefined) results = results.slice(0, opts.limit);
  return results;
}

export const QUERY_FIELDS = [
  "target",
  "normalized",
  "expected_destination",
  "classification_confidence",
  "title_features",
  "occurrences",
  "stats",
  "occurrence_count",
] as const;

/** Parse a comma-separated field list; throws listing valid fields on unknown names. */
export function parseFields(raw: string | string[]): string[] {
  const fields = (Array.isArray(raw) ? raw : raw.split(",")).map((f) => f.trim()).filter(Boolean);
  const unknown = fields.filter((f) => !(QUERY_FIELDS as readonly string[]).includes(f));
  if (fields.length === 0 || unknown.length > 0) {
    const bad = unknown.length > 0 ? `Unknown field(s): ${unknown.join(", ")}. ` : "No fields given. ";
    throw new Error(`${bad}Valid fields: ${QUERY_FIELDS.join(", ")}`);
  }
  return fields;
}

/** Project a record to the given top-level fields (`occurrence_count` is derived from stats). */
export function projectFields(link: LinkRecord, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    out[f] = f === "occurrence_count" ? link.stats.total_occurrences : (link as unknown as Record<string, unknown>)[f];
  }
  return out;
}

/** Most-used target in a cluster; ties go to the alphabetically first. Missing counts count as 0. */
export function suggestCanonical(group: string[], counts: Map<string, number>): string {
  return [...group].sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))[0]!;
}

/**
 * One NDJSON line per cluster (caller sorts). Empty input yields no lines.
 * With `counts`, each line also carries the suggested `canonical` target and per-target `occurrences`.
 */
export function formatClustersJson(groups: string[][], threshold: number, counts?: Map<string, number>): string[] {
  return groups.map((g) => JSON.stringify({
    size: g.length,
    threshold,
    targets: g,
    ...(counts && {
      canonical: suggestCanonical(g, counts),
      occurrences: Object.fromEntries(g.map((t) => [t, counts.get(t) ?? 0])),
    }),
  }));
}

export function formatSummary(links: LinkRecord[]): string {
  const header = `${"count".padStart(5)}  ${"class".padEnd(10)}  ${"conf".padEnd(7)}  target`;
  const divider = "-".repeat(80);
  const rows = links.map((l) =>
    `${String(l.stats.total_occurrences).padStart(5)}  ${l.expected_destination.padEnd(10)}  ${l.classification_confidence.padEnd(7)}  ${l.target}`
  );
  return [header, divider, ...rows].join("\n");
}

export function formatDetailed(links: LinkRecord[]): string {
  const out: string[] = [];
  for (const link of links) {
    out.push(
      `\n=== ${link.target}  (${link.expected_destination}, ${link.classification_confidence} confidence, ${link.stats.total_occurrences}x)`
    );
    for (const occ of link.occurrences) {
      const loc = `${occ.source}:${occ.line}`;
      const tag = occ.semantic_type ? ` [${occ.semantic_type}]` : "";
      const alias = occ.alias ? ` |${occ.alias}` : "";
      out.push(`  ${loc}${tag}${alias}`);
      out.push(`    …${occ.context_before} [[${link.target}${alias}]] ${occ.context_after}…`);
    }
  }
  return out.join("\n");
}
