import type { MarkdownConfig } from "@lezer/markdown";

const BRACKET_OPEN = 91; // "["
const BRACKET_CLOSE = 93; // "]"
const NEWLINE = 10;

/**
 * Obsidian-style [[wiki link]] inline syntax as a lezer-markdown
 * extension. Produces:
 *
 *   WikiLink
 *   ├─ WikiLinkMark  "[["
 *   ├─ (link target text, plain)
 *   └─ WikiLinkMark  "]]"
 *
 * Runs before the standard Link parser so `[[x]]` isn't half-consumed
 * as a normal `[x]` link label.
 */
export const wikiLinkExtension: MarkdownConfig = {
  defineNodes: [{ name: "WikiLink" }, { name: "WikiLinkMark" }],
  parseInline: [
    {
      name: "WikiLink",
      before: "Link",
      parse(cx, next, pos) {
        if (next !== BRACKET_OPEN || cx.char(pos + 1) !== BRACKET_OPEN) {
          return -1;
        }
        for (let i = pos + 2; i < cx.end - 1; i++) {
          const ch = cx.char(i);
          if (ch === NEWLINE) return -1;
          if (ch === BRACKET_CLOSE && cx.char(i + 1) === BRACKET_CLOSE) {
            if (i === pos + 2) return -1; // empty [[]]
            return cx.addElement(
              cx.elt("WikiLink", pos, i + 2, [
                cx.elt("WikiLinkMark", pos, pos + 2),
                cx.elt("WikiLinkMark", i, i + 2),
              ]),
            );
          }
        }
        return -1;
      },
    },
  ],
};

/** Extract the target text of a WikiLink node's source, e.g. "note" from "[[note]]". */
export function wikiLinkTarget(sourceText: string): string {
  return sourceText.replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
}
