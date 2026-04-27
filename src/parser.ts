import { unified } from "unified";
import remarkParse from "remark-parse";
import { visit } from "unist-util-visit";
import type { Root, Text, Parent, PhrasingContent } from "mdast";
import type { Processor } from "unified";

// ── Custom AST node types ─────────────────────────────────────────────────────

export interface WikiLinkNode {
  type: "wikiLink";
  target: string;
  alias: string | undefined;
  position?: import("unist").Position;
}

export interface InlineFieldNode {
  type: "inlineField";
  key: string;
  children: ContentNode[];
  position?: import("unist").Position;
}

// Extend mdast's phrasing content map so TypeScript accepts these nodes
declare module "mdast" {
  interface PhrasingContentMap {
    wikiLink: WikiLinkNode;
    inlineField: InlineFieldNode;
  }
  interface RootContentMap {
    wikiLink: WikiLinkNode;
    inlineField: InlineFieldNode;
  }
}

type ContentNode = PhrasingContent | WikiLinkNode | InlineFieldNode;

// ── Micromark extension: [[wikilinks]] ───────────────────────────────────────
//
// Tokenises [[target]], [[target|alias]], [[target#section]], [[target^ref]].
// The outer `[` character code (91) is the dispatch hook.

const OPEN_BRACKET = 91;  // [
const CLOSE_BRACKET = 93; // ]

function wikilinkSyntax() {
  return { text: { [OPEN_BRACKET]: wikilinkConstruct } };
}

const wikilinkConstruct = {
  name: "wikiLink",
  tokenize: wikilinkTokenize,
};

function wikilinkTokenize(
  effects: any,
  ok: (code: any) => any,
  nok: (code: any) => any,
) {
  return start;

  function start(code: number): any {
    if (code !== OPEN_BRACKET) return nok(code);
    effects.enter("wikiLink");
    effects.enter("wikiLinkMarker");
    effects.consume(code); // first [
    return openBracket2;
  }

  function openBracket2(code: number): any {
    if (code !== OPEN_BRACKET) return nok(code); // single [ — not a wikilink
    effects.consume(code); // second [
    effects.exit("wikiLinkMarker");
    effects.enter("wikiLinkData");
    return data;
  }

  function data(code: number): any {
    // EOF (-1) or any line-ending code (-5 \r\n, -4 \n, -3 \r) → abandon
    if (code === null || code === -5 || code === -4 || code === -3) return nok(code);
    if (code === CLOSE_BRACKET) {
      effects.exit("wikiLinkData");
      effects.enter("wikiLinkMarker");
      effects.consume(code); // first ]
      return closeBracket2;
    }
    effects.consume(code);
    return data;
  }

  function closeBracket2(code: number): any {
    if (code !== CLOSE_BRACKET) return nok(code); // single ] — not end of wikilink
    effects.consume(code); // second ]
    effects.exit("wikiLinkMarker");
    effects.exit("wikiLink");
    return ok;
  }
}

// ── mdast extension: wikiLink tokens → WikiLinkNode ──────────────────────────

function wikilinkFromMarkdown() {
  return {
    enter: {
      wikiLink(this: any, token: any) {
        this.enter({ type: "wikiLink", target: "", alias: undefined }, token);
      },
      wikiLinkData(this: any) {
        this.buffer();
      },
    },
    exit: {
      wikiLinkData(this: any) {
        const raw = this.resume() as string;
        const node = this.stack[this.stack.length - 1] as WikiLinkNode;
        let target = raw;
        let alias: string | undefined;
        const pipeIdx = target.indexOf("|");
        if (pipeIdx !== -1) {
          alias = target.slice(pipeIdx + 1).trim();
          target = target.slice(0, pipeIdx);
        }
        for (const sep of ["#", "^"]) {
          const idx = target.indexOf(sep);
          if (idx !== -1) target = target.slice(0, idx);
        }
        node.target = target.trim();
        node.alias = alias;
      },
      wikiLink(this: any, token: any) {
        this.exit(token);
      },
    },
  };
}

// ── Remark plugin: [[wikilinks]] ─────────────────────────────────────────────
//
// Registers the micromark syntax + mdast builder on the unified processor.

function remarkWikilinks(this: Processor) {
  const data = this.data() as Record<string, unknown[]>;
  (data.micromarkExtensions ??= []).push(wikilinkSyntax());
  (data.fromMarkdownExtensions ??= []).push(wikilinkFromMarkdown());
}

// ── Remark plugin: (key:: ...) inline fields ─────────────────────────────────
//
// Runs as a tree transformer after remark-parse. Visits every parent node and
// restructures its children array to wrap (key:: ...) spans in InlineFieldNode
// values, preserving any WikiLinkNode children already inside the span.

const FIELD_OPEN_RE = /\(([A-Za-z][A-Za-z0-9_-]*)::[ \t]*/;

function remarkInlineFields() {
  return (tree: Root) => {
    visit(tree, (node) => {
      if (!("children" in node)) return;
      const parent = node as Parent;
      const next = transformChildren(parent.children as ContentNode[]);
      if (next !== parent.children) (parent as any).children = next;
    });
  };
}

function transformChildren(input: readonly ContentNode[]): ContentNode[] {
  // Mutable working copy; we re-splice when we inject a tail text node.
  const nodes: ContentNode[] = [...input];
  const result: ContentNode[] = [];
  let changed = false;
  let i = 0;

  while (i < nodes.length) {
    const node = nodes[i]!;

    if (node.type !== "text") {
      result.push(node);
      i++;
      continue;
    }

    const text = (node as Text).value;
    const m = FIELD_OPEN_RE.exec(text);
    if (!m) {
      result.push(node);
      i++;
      continue;
    }

    changed = true;
    const key = m[1]!;
    const openIdx = m.index;
    const afterOpen = text.slice(openIdx + m[0].length);

    if (openIdx > 0) result.push({ type: "text", value: text.slice(0, openIdx) });

    const fieldChildren: ContentNode[] = [];

    // Fast path: close paren is in the same text node.
    const immediateClose = afterOpen.indexOf(")");
    if (immediateClose !== -1) {
      const inner = afterOpen.slice(0, immediateClose);
      if (inner) fieldChildren.push({ type: "text", value: inner });
      result.push({ type: "inlineField", key, children: fieldChildren } as InlineFieldNode);
      const tail = afterOpen.slice(immediateClose + 1);
      if (tail) {
        // Reinject tail so it can be scanned for further fields.
        nodes[i] = { type: "text", value: tail };
      } else {
        i++;
      }
      continue;
    }

    // Close paren is in a later sibling.
    if (afterOpen) fieldChildren.push({ type: "text", value: afterOpen });
    i++;

    let foundClose = false;
    while (i < nodes.length) {
      const sib = nodes[i]!;
      if (sib.type === "text") {
        const sibText = (sib as Text).value;
        const closeIdx = sibText.indexOf(")");
        if (closeIdx !== -1) {
          if (closeIdx > 0) fieldChildren.push({ type: "text", value: sibText.slice(0, closeIdx) });
          result.push({ type: "inlineField", key, children: fieldChildren } as InlineFieldNode);
          const tail = sibText.slice(closeIdx + 1);
          if (tail) {
            nodes[i] = { type: "text", value: tail };
          } else {
            i++;
          }
          foundClose = true;
          break;
        }
        fieldChildren.push(sib);
        i++;
      } else {
        fieldChildren.push(sib);
        i++;
      }
    }

    if (!foundClose) {
      // Unmatched open paren — emit everything as-is.
      result.push({ type: "text", value: text.slice(openIdx) });
      result.push(...fieldChildren);
    }
  }

  return changed ? result : (input as ContentNode[]);
}

// ── Unified processor ─────────────────────────────────────────────────────────

const processor = unified()
  .use(remarkParse)
  .use(remarkWikilinks)
  .use(remarkInlineFields);

export function parseMarkdownAST(text: string): Root {
  const tree = processor.parse(text);
  return processor.runSync(tree, text) as Root;
}

// ── Extraction helpers ────────────────────────────────────────────────────────

export interface ParsedWikiLink {
  target: string;
  alias: string | undefined;
  semanticType: string | undefined;
  /** 1-indexed line number */
  line: number;
  /** Character offset from start of document */
  startOffset: number;
  endOffset: number;
}

const SENTENCE_BOUNDARY_RE = /(?<=[.!?])\s+/;
const CONTEXT_CHAR_WINDOW = 200;

/**
 * Extracts plain-text context windows around a wikilink using character offsets
 * rather than a line-slicing heuristic.
 */
export function extractContext(
  text: string,
  startOffset: number,
  endOffset: number,
): [string, string] {
  const beforeRaw = text.slice(0, startOffset).trimEnd();
  const afterRaw = text.slice(endOffset).trimStart();

  let before = beforeRaw.slice(-CONTEXT_CHAR_WINDOW);
  const sentencesBefore = before.split(SENTENCE_BOUNDARY_RE);
  if (sentencesBefore.length > 1) before = sentencesBefore[sentencesBefore.length - 1]!;

  let after = afterRaw.slice(0, CONTEXT_CHAR_WINDOW);
  const sentencesAfter = after.split(SENTENCE_BOUNDARY_RE);
  if (sentencesAfter.length > 1) after = sentencesAfter[0]!;

  return [before.trim(), after.trim()];
}

/**
 * Walks the AST and returns one ParsedWikiLink per [[wikilink]] occurrence.
 *
 * Semantic types are resolved structurally: a wikilink that is a descendant of
 * an InlineFieldNode inherits that node's key as its semantic type, regardless
 * of how many levels deep it is nested.
 */
export function extractWikiLinks(tree: Root): ParsedWikiLink[] {
  // First pass: map each wikilink's start offset → its nearest inlineField key.
  const fieldKeyByOffset = new Map<number, string>();
  visit(tree, "inlineField", (fieldNode) => {
    const field = fieldNode as unknown as InlineFieldNode;
    visit(field as any, "wikiLink", (wlNode) => {
      const wl = wlNode as unknown as WikiLinkNode;
      const offset = wl.position?.start.offset;
      if (offset !== undefined) fieldKeyByOffset.set(offset, field.key);
    });
  });

  // Second pass: collect all wikilink occurrences.
  const results: ParsedWikiLink[] = [];
  visit(tree, "wikiLink", (node) => {
    const wl = node as unknown as WikiLinkNode;
    if (!wl.position) return;
    const startOffset = wl.position.start.offset ?? 0;
    const endOffset = wl.position.end.offset ?? startOffset;
    results.push({
      target: wl.target,
      alias: wl.alias,
      semanticType: fieldKeyByOffset.get(startOffset),
      line: wl.position.start.line,
      startOffset,
      endOffset,
    });
  });

  return results;
}
