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
