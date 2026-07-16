import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, type EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

/**
 * Obsidian-style Live Preview for Markdown, built on CM6 decorations.
 *
 * Principle: markers (#, **, `, [[ ]], ...) are hidden with
 * Decoration.replace while the cursor is elsewhere, and revealed when
 * the selection touches the element - line-scoped for block elements
 * (headings, HR, tasks), node-scoped for inline elements (bold,
 * italic, code, links). The document text itself is never modified;
 * everything here is a view-layer overlay.
 *
 * Interactive bits (handled in App via EditorView.domEventHandlers):
 *   - Task checkboxes: rendered as real <input type=checkbox>.
 *   - Ctrl+click on links / URLs / wiki links.
 */

// ---------------------------------------------------------------------
// Widgets

class CheckboxWidget extends WidgetType {
  constructor(private checked: boolean) {
    super();
  }
  override eq(other: CheckboxWidget) {
    return other.checked === this.checked;
  }
  toDOM() {
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = this.checked;
    box.className = "cm-task-checkbox";
    // Position lookup and text toggling happen in the mousedown handler
    // registered by taskToggleHandler() below - the widget itself stays
    // dumb so stale position captures can't corrupt the document.
    box.dataset.kotoshelfTask = "1";
    return box;
  }
  override ignoreEvent() {
    // Let mousedown reach our dom event handler.
    return false;
  }
}

class HrWidget extends WidgetType {
  toDOM() {
    const hr = document.createElement("span");
    hr.className = "cm-rendered-hr";
    return hr;
  }
}

// ---------------------------------------------------------------------
// Selection helpers

function selectionTouches(state: EditorState, from: number, to: number): boolean {
  for (const range of state.selection.ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

function selectionOnLine(state: EditorState, pos: number): boolean {
  const line = state.doc.lineAt(pos);
  return selectionTouches(state, line.from, line.to);
}

// ---------------------------------------------------------------------
// Decoration computation

interface Deco {
  from: number;
  to: number;
  deco: Decoration;
}

const headingClasses: Record<string, string> = {
  ATXHeading1: "cm-lp-h1",
  ATXHeading2: "cm-lp-h2",
  ATXHeading3: "cm-lp-h3",
  ATXHeading4: "cm-lp-h4",
  ATXHeading5: "cm-lp-h5",
  ATXHeading6: "cm-lp-h6",
};

function buildDecorations(view: EditorView): DecorationSet {
  const state = view.state;
  const decos: Deco[] = [];
  const doc = state.doc;

  const hide = (from: number, to: number) =>
    decos.push({ from, to, deco: Decoration.replace({}) });
  const mark = (from: number, to: number, cls: string) => {
    if (from < to) decos.push({ from, to, deco: Decoration.mark({ class: cls }) });
  };
  const lineDeco = (pos: number, cls: string) =>
    decos.push({
      from: doc.lineAt(pos).from,
      to: doc.lineAt(pos).from,
      deco: Decoration.line({ class: cls }),
    });

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter(node) {
        const name = node.name;

        // ----- headings -------------------------------------------------
        if (name in headingClasses) {
          lineDeco(node.from, headingClasses[name]);
          if (!selectionOnLine(state, node.from)) {
            const markNode = node.node.getChild("HeaderMark");
            if (markNode) {
              // Also swallow the single space after the #'s.
              const spaceEnd =
                doc.sliceString(markNode.to, markNode.to + 1) === " "
                  ? markNode.to + 1
                  : markNode.to;
              hide(markNode.from, spaceEnd);
            }
          }
          return;
        }

        // ----- horizontal rule ------------------------------------------
        if (name === "HorizontalRule") {
          if (!selectionOnLine(state, node.from)) {
            decos.push({
              from: node.from,
              to: node.to,
              deco: Decoration.replace({ widget: new HrWidget() }),
            });
          }
          return;
        }

        // ----- emphasis --------------------------------------------------
        if (name === "StrongEmphasis" || name === "Emphasis") {
          const cls = name === "StrongEmphasis" ? "cm-lp-strong" : "cm-lp-em";
          mark(node.from, node.to, cls);
          if (!selectionTouches(state, node.from, node.to)) {
            for (const m of node.node.getChildren("EmphasisMark")) {
              hide(m.from, m.to);
            }
          }
          return;
        }

        // ----- strikethrough (GFM) --------------------------------------
        if (name === "Strikethrough") {
          mark(node.from, node.to, "cm-lp-strike");
          if (!selectionTouches(state, node.from, node.to)) {
            for (const m of node.node.getChildren("StrikethroughMark")) {
              hide(m.from, m.to);
            }
          }
          return;
        }

        // ----- inline code ----------------------------------------------
        if (name === "InlineCode") {
          mark(node.from, node.to, "cm-lp-inline-code");
          if (!selectionTouches(state, node.from, node.to)) {
            for (const m of node.node.getChildren("CodeMark")) {
              hide(m.from, m.to);
            }
          }
          return;
        }

        // ----- fenced code block ----------------------------------------
        if (name === "FencedCode") {
          const first = doc.lineAt(node.from).number;
          const last = doc.lineAt(node.to).number;
          for (let n = first; n <= last; n++) {
            lineDeco(doc.line(n).from, "cm-lp-codeblock");
          }
          return;
        }

        // ----- blockquote ------------------------------------------------
        if (name === "Blockquote") {
          const first = doc.lineAt(node.from).number;
          const last = doc.lineAt(node.to).number;
          for (let n = first; n <= last; n++) {
            lineDeco(doc.line(n).from, "cm-lp-blockquote");
          }
          return;
        }
        if (name === "QuoteMark") {
          mark(node.from, node.to, "cm-lp-quote-mark");
          return;
        }

        // ----- lists ------------------------------------------------------
        if (name === "ListMark") {
          mark(node.from, node.to, "cm-lp-list-mark");
          return;
        }

        // ----- GFM task ---------------------------------------------------
        if (name === "Task") {
          const marker = node.node.getChild("TaskMarker");
          if (!marker) return;
          const rawMarker = doc.sliceString(marker.from, marker.to);
          const checked = /x/i.test(rawMarker);
          if (checked) {
            mark(marker.to, node.to, "cm-lp-task-done");
          }
          if (!selectionOnLine(state, node.from)) {
            decos.push({
              from: marker.from,
              to: Math.min(marker.to + 1, node.to), // include trailing space
              deco: Decoration.replace({ widget: new CheckboxWidget(checked) }),
            });
          }
          return;
        }

        // ----- links ------------------------------------------------------
        if (name === "Link") {
          const linkNode = node.node;
          mark(node.from, node.to, "cm-lp-link");
          if (!selectionTouches(state, node.from, node.to)) {
            for (const m of linkNode.getChildren("LinkMark")) hide(m.from, m.to);
            const url = linkNode.getChild("URL");
            if (url) hide(url.from, url.to);
          }
          return;
        }
        if (name === "URL" && node.node.parent?.name !== "Link") {
          // GFM autolinked bare URL.
          mark(node.from, node.to, "cm-lp-link");
          return;
        }

        // ----- wiki link (custom parser in wikilink.ts) -------------------
        if (name === "WikiLink") {
          mark(node.from, node.to, "cm-lp-wikilink");
          if (!selectionTouches(state, node.from, node.to)) {
            for (const m of node.node.getChildren("WikiLinkMark")) {
              hide(m.from, m.to);
            }
          }
          return;
        }
      },
    });

    // ----- footnote markers [^1] (not in the GFM parse tree) ------------
    const text = doc.sliceString(from, to);
    const footnoteRe = /\[\^[^\]\s]+\]/g;
    for (let m = footnoteRe.exec(text); m; m = footnoteRe.exec(text)) {
      mark(from + m.index, from + m.index + m[0].length, "cm-lp-footnote");
    }
  }

  // RangeSetBuilder requires sorted input: by from, then by side/kind.
  // Line decorations (zero-length at line start) must come before marks
  // starting at the same position.
  decos.sort(
    (a, b) =>
      a.from - b.from ||
      (a.deco.spec.class && !b.deco.spec.class ? -1 : 0) ||
      a.to - b.to,
  );
  const builder = new RangeSetBuilder<Decoration>();
  for (const d of decos) {
    try {
      builder.add(d.from, d.to, d.deco);
    } catch {
      // Overlapping/out-of-order edge cases (e.g. nested emphasis marks
      // hidden twice) - skip rather than blow up the whole view.
    }
  }
  return builder.finish();
}

// ---------------------------------------------------------------------
// Plugin + theme

const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

const livePreviewTheme = EditorView.baseTheme({
  ".cm-lp-h1": { fontSize: "1.6em", fontWeight: "700" },
  ".cm-lp-h2": { fontSize: "1.4em", fontWeight: "700" },
  ".cm-lp-h3": { fontSize: "1.2em", fontWeight: "700" },
  ".cm-lp-h4": { fontSize: "1.1em", fontWeight: "600" },
  ".cm-lp-h5": { fontSize: "1em", fontWeight: "600" },
  ".cm-lp-h6": { fontSize: "0.9em", fontWeight: "600", opacity: "0.8" },
  ".cm-lp-strong": { fontWeight: "700" },
  ".cm-lp-em": { fontStyle: "italic" },
  ".cm-lp-strike": { textDecoration: "line-through", opacity: "0.7" },
  ".cm-lp-inline-code": {
    fontFamily: "ui-monospace, monospace",
    borderRadius: "3px",
  },
  "&light .cm-lp-inline-code": { backgroundColor: "#e2e8f0" },
  "&dark .cm-lp-inline-code": { backgroundColor: "#334155" },
  ".cm-lp-codeblock": { fontFamily: "ui-monospace, monospace" },
  "&light .cm-lp-codeblock": { backgroundColor: "#f1f5f9" },
  "&dark .cm-lp-codeblock": { backgroundColor: "#1e293b" },
  "&light .cm-lp-blockquote": {
    backgroundColor: "#f8fafc",
    borderLeft: "3px solid #cbd5e1",
  },
  "&dark .cm-lp-blockquote": {
    backgroundColor: "#0f172a",
    borderLeft: "3px solid #475569",
  },
  ".cm-lp-quote-mark": { opacity: "0.5" },
  ".cm-lp-list-mark": { color: "#f59e0b", fontWeight: "700" },
  ".cm-lp-task-done": { textDecoration: "line-through", opacity: "0.6" },
  ".cm-task-checkbox": {
    verticalAlign: "middle",
    margin: "0 0.4em 0 0",
    cursor: "pointer",
  },
  ".cm-lp-link": { color: "#3b82f6", textDecoration: "underline", cursor: "pointer" },
  ".cm-lp-wikilink": { color: "#8b5cf6", textDecoration: "underline", cursor: "pointer" },
  ".cm-lp-footnote": { color: "#f59e0b" },
  ".cm-rendered-hr": {
    display: "inline-block",
    width: "100%",
    borderTop: "2px solid #94a3b8",
    verticalAlign: "middle",
  },
});

export function livePreview() {
  return [livePreviewPlugin, livePreviewTheme];
}
