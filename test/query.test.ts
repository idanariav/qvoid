import { describe, it, expect } from "vitest";
import { parseFields, projectFields, QUERY_FIELDS } from "../src/query.js";
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
