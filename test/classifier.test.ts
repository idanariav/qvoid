import { describe, it, expect } from "vitest";
import { Classifier } from "../src/classifier.js";
import { DEFAULT_CONFIG, type CollectionConfig } from "../src/config.js";
import type { Occurrence } from "../src/types.js";

function occ(overrides: Partial<Occurrence> = {}): Occurrence {
  return {
    source: "note.md",
    source_folder: "note.md",
    line: 1,
    context_before: "",
    context_after: "",
    ...overrides,
  };
}

const classifier = new Classifier(DEFAULT_CONFIG);

describe("heuristic classification (default config)", () => {
  it.each([
    ["{{template}}", "template", "high"],
    ["notes/file", "file", "high"],
    ["report.pdf", "file", "high"],
    ["@John Smith", "person", "high"],
    ["John Smith", "person", "medium"],
    ["2024-01-15", "date", "high"],
    ["Some Paper (2020)", "idea", "high"],
    ["Smith et al.", "idea", "high"],
    ["Play improves focus", "idea", "high"],
    ["NASA", "unknown", "high"],
    ["SomeThingHere", "file", "medium"],
    ["Quantum Computing Research Notes", "idea", "medium"],
    ["x", "idea", "low"],
    ["", "unknown", "low"],
  ] as const)("classifies %j as [%s, %s]", (target, dest, conf) => {
    const [cls, confidence] = classifier.classify(target, []);
    expect(cls).toBe(dest);
    expect(confidence).toBe(conf);
  });

  it("template syntax takes precedence over the file-extension rule", () => {
    const [cls] = classifier.classify("{{template}}.md", []);
    expect(cls).toBe("template");
  });
});

describe("context boost", () => {
  it("does not affect an already-high-confidence base classification", () => {
    const occs = [occ({ semantic_type: "Supports" })];
    const [cls, conf] = classifier.classify("2024-01-15", occs);
    expect([cls, conf]).toEqual(["date", "high"]);
  });

  it("promotes a low-confidence idea to high with a strong annotation (+3)", () => {
    const occs = [occ({ semantic_type: "Supports" })];
    const [cls, conf] = classifier.classify("x", occs);
    expect([cls, conf]).toEqual(["idea", "high"]);
  });

  it("promotes a low-confidence idea to medium with a weak annotation (+1)", () => {
    const occs = [occ({ semantic_type: "Related" })];
    const [cls, conf] = classifier.classify("x", occs);
    expect([cls, conf]).toEqual(["idea", "medium"]);
  });

  it("promotes to high when multiple weak annotations sum to >= 3", () => {
    const occs = [occ({ semantic_type: "Related" }), occ({ semantic_type: "Aka" }), occ({ semantic_type: "Jump" })];
    const [cls, conf] = classifier.classify("x", occs);
    expect([cls, conf]).toEqual(["idea", "high"]);
  });

  it("adds a citation-folder boost only when there's no semantic_type", () => {
    const cfg: CollectionConfig = {
      ...DEFAULT_CONFIG,
      classifier: { ...DEFAULT_CONFIG.classifier, citation_folders: ["Sources"] },
    };
    const clf = new Classifier(cfg);
    const boosted = clf.classify("x", [occ({ source_folder: "Sources/Articles" })]);
    expect(boosted).toEqual(["idea", "medium", boosted[2]]);

    const notBoosted = clf.classify("x", [occ({ source_folder: "Sources/Articles", semantic_type: "Related" })]);
    // Same weak-annotation boost (+1) as without citation folder, since the two don't stack.
    expect(notBoosted[1]).toBe("medium");
  });

  it("leaves an unresolved low-confidence idea alone with no boosting signal", () => {
    const [cls, conf] = classifier.classify("x", [occ()]);
    expect([cls, conf]).toEqual(["idea", "low"]);
  });
});

describe("config-driven heuristics", () => {
  it("disables the person heuristic when classifier.heuristics.person is false", () => {
    const cfg: CollectionConfig = {
      ...DEFAULT_CONFIG,
      classifier: {
        ...DEFAULT_CONFIG.classifier,
        heuristics: { ...DEFAULT_CONFIG.classifier.heuristics, person: false },
      },
    };
    const clf = new Classifier(cfg);
    const [cls] = clf.classify("@John", []);
    expect(cls).not.toBe("person");
  });

  it("honors a custom person_prefix", () => {
    const cfg: CollectionConfig = {
      ...DEFAULT_CONFIG,
      classifier: { ...DEFAULT_CONFIG.classifier, person_prefix: "&" },
    };
    const clf = new Classifier(cfg);
    expect(clf.classify("&Jane Doe", [])).toEqual(["person", "high", expect.anything()]);
    expect(clf.classify("@Jane Doe", [])[0]).not.toBe("person");
  });
});
