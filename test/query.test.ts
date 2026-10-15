import { describe, it, expect } from "vitest";
import { parseFields, projectFields, formatClustersJson, suggestCanonical, QUERY_FIELDS } from "../src/query.js";
import type { LinkRecord } from "../src/types.js";

const link = {
  target: "Foo",
  normalized: "foo",
  expected_destination: "idea",
  classification_confidence: "high",
  title_features: {},
  occurrences: [{}, {}],
  stats: { total_occurrences: 2, unique_source_folders: 1, semantic_types: [] },
} as unknown as LinkRecord;

describe("parseFields", () => {
  it("splits and trims", () => {
    expect(parseFields("target, occurrence_count")).toEqual(["target", "occurrence_count"]);
  });
  it("accepts arrays", () => {
    expect(parseFields(["target"])).toEqual(["target"]);
  });
  it("errors on unknown fields listing valid ones", () => {
    expect(() => parseFields("target,bogus")).toThrow(/bogus.*Valid fields: target/);
  });
  it("errors on empty", () => {
    expect(() => parseFields(",")).toThrow(/No fields/);
  });
});

describe("projectFields", () => {
  it("projects only requested fields, with derived occurrence_count", () => {
    expect(projectFields(link, ["target", "occurrence_count", "expected_destination", "classification_confidence"])).toEqual({
      target: "Foo",
      occurrence_count: 2,
      expected_destination: "idea",
      classification_confidence: "high",
    });
  });
  it("every advertised field is selectable", () => {
    const out = projectFields(link, [...QUERY_FIELDS]);
    expect(Object.keys(out)).toEqual([...QUERY_FIELDS]);
  });
});

describe("formatClustersJson", () => {
  it("emits one NDJSON object per cluster in given order", () => {
    const lines = formatClustersJson([["a", "b", "c"], ["d", "e"]], 0.82);
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { size: 3, threshold: 0.82, targets: ["a", "b", "c"] },
      { size: 2, threshold: 0.82, targets: ["d", "e"] },
    ]);
  });
  it("yields nothing for no clusters", () => {
    expect(formatClustersJson([], 0.82)).toEqual([]);
  });
  it("adds canonical and occurrences when counts are given", () => {
    const counts = new Map([["a", 1], ["b", 4]]);
    expect(JSON.parse(formatClustersJson([["a", "b"]], 0.82, counts)[0]!)).toEqual({
      size: 2, threshold: 0.82, targets: ["a", "b"], canonical: "b", occurrences: { a: 1, b: 4 },
    });
  });
});

describe("suggestCanonical", () => {
  it("picks the most-used target", () => {
    expect(suggestCanonical(["a", "b", "c"], new Map([["a", 1], ["b", 3], ["c", 2]]))).toBe("b");
  });
  it("breaks ties alphabetically", () => {
    expect(suggestCanonical(["b", "a"], new Map([["a", 2], ["b", 2]]))).toBe("a");
  });
});
