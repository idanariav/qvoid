import { describe, it, expect } from "vitest";
import { parseMarkdownAST, extractWikiLinks, extractContext } from "../src/parser.js";

function links(text: string) {
  return extractWikiLinks(parseMarkdownAST(text), text);
}

describe("wikilink tokenizer", () => {
  it("parses a plain [[target]]", () => {
    const [l] = links("See [[Some Target]] here.");
    expect(l).toMatchObject({ target: "Some Target", alias: undefined, semanticType: undefined });
  });

  it("splits alias on the first |", () => {
    const [l] = links("[[Target|Display Text]]");
    expect(l).toMatchObject({ target: "Target", alias: "Display Text" });
  });

  it("strips a #section suffix from the target", () => {
    const [l] = links("[[Target#Some Section]]");
    expect(l!.target).toBe("Target");
  });

  it("strips a ^block suffix from the target", () => {
    const [l] = links("[[Target^abc123]]");
    expect(l!.target).toBe("Target");
  });

  it("does not tokenize a single unmatched bracket", () => {
    expect(links("This [is not a link].")).toHaveLength(0);
  });

  it("does not tokenize an unclosed [[wikilink across a line break", () => {
    expect(links("Open [[Target\nNext line")).toHaveLength(0);
  });

  it("finds multiple links in one line with correct line numbers", () => {
    const result = links("# H\n\n[[First]] and [[Second]] on line 3.");
    expect(result.map((l) => l.target)).toEqual(["First", "Second"]);
    expect(result.every((l) => l.line === 3)).toBe(true);
  });
});

describe("inline field transformer", () => {
  it("captures the field key as semanticType for a wikilink inside (Key:: [[target]])", () => {
    const [l] = links("(Supports:: [[Claim A]])");
    expect(l).toMatchObject({ target: "Claim A", semanticType: "Supports" });
  });

  it("supports multiple wikilinks inside one field", () => {
    const result = links("(Related:: [[A]] and [[B]])");
    expect(result).toHaveLength(2);
    expect(result.every((l) => l.semanticType === "Related")).toBe(true);
  });

  it("leaves plain parenthetical text alone", () => {
    const result = links("(just a note, no field here) [[Target]]");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ target: "Target", semanticType: undefined });
  });

  it("does not tag a wikilink outside the field's parens", () => {
    const result = links("(Supports:: [[A]]) but not [[B]]");
    expect(result.find((l) => l.target === "A")!.semanticType).toBe("Supports");
    expect(result.find((l) => l.target === "B")!.semanticType).toBeUndefined();
  });
});

describe("frontmatter handling", () => {
  it("recognizes a leading YAML block as a distinct node, not body text", () => {
    const text = "---\ntitle: Note\n---\n# Heading\n";
    const tree = parseMarkdownAST(text);
    expect(tree.children.map((c) => c.type)).toEqual(["yaml", "heading"]);
  });

  it("does not misparse a mid-document --- as frontmatter", () => {
    const text = "# Note\n\nSome text.\n\n---\n\nMore text.\n";
    const tree = parseMarkdownAST(text);
    expect(tree.children.map((c) => c.type)).toEqual(["heading", "paragraph", "thematicBreak", "paragraph"]);
  });

  it("recovers wikilinks inside frontmatter and tags them", () => {
    const text = '---\ntopic: "[[Some Concept]]"\n---\n# Note\n';
    const [l] = links(text);
    expect(l).toMatchObject({ target: "Some Concept", semanticType: "frontmatter" });
  });

  it("still finds body links alongside frontmatter links", () => {
    const text = '---\ntopic: "[[FM Target]]"\n---\n\nBody has [[Body Target]].\n';
    const result = links(text);
    expect(result.map((l) => l.target).sort()).toEqual(["Body Target", "FM Target"]);
    expect(result.find((l) => l.target === "Body Target")!.semanticType).toBeUndefined();
  });
});

describe("extractContext", () => {
  it("returns trimmed text before and after the given offsets", () => {
    const text = "Hello world, this is context. [[Target]] Then more context follows.";
    const start = text.indexOf("[[Target]]");
    const end = start + "[[Target]]".length;
    const [before, after] = extractContext(text, start, end);
    expect(before.endsWith("this is context.")).toBe(true);
    expect(after.startsWith("Then more context")).toBe(true);
  });

  it("keeps only the last sentence before the link when the window spans sentence boundaries", () => {
    const text = "First sentence here. Second sentence right before. [[Target]]";
    const start = text.indexOf("[[Target]]");
    const [before] = extractContext(text, start, start);
    expect(before).toBe("Second sentence right before.");
  });
});
