import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import {
  findTemplateVarToExpand,
  type TemplateContext,
} from "../lib/templateVars";

/**
 * Expands `{{var}}` to its evaluated value the moment the closing `}}` is
 * typed - static/insert-time only, see templateVars.ts. ctxRef is a ref
 * (not a plain object) so the extension - built once per tab via useMemo
 * in App.tsx - always reads the current filename/workspace/content
 * without needing to be rebuilt on every keystroke.
 */
export function templateExpansion(ctxRef: { current: TemplateContext }) {
  return ViewPlugin.fromClass(
    class {
      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        // Only react to a plain single-character insert (the user typing
        // the closing brace) - programmatic changes (paste, our own
        // replacement dispatch, undo/redo) should never re-trigger this.
        let isSimpleTyping = false;
        let insertedText = "";
        update.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
          insertedText += inserted.toString();
        });
        isSimpleTyping = insertedText.length > 0 && update.transactions.some(
          (tr) => tr.isUserEvent("input.type"),
        );
        if (!isSimpleTyping) return;

        const pos = update.state.selection.main.head;
        // Look back far enough to catch a whole {{...}} expression
        // without scanning the entire (potentially huge) document.
        const windowStart = Math.max(0, pos - 200);
        const before = update.state.sliceDoc(windowStart, pos);
        const found = findTemplateVarToExpand(before, ctxRef.current);
        if (!found) return;

        const from = windowStart + found.start;
        const to = pos;
        // Deferred: dispatching inside the same update that produced it
        // confuses CM6's update cycle. requestAnimationFrame keeps it
        // off the current transaction.
        requestAnimationFrame(() => {
          update.view.dispatch({
            changes: { from, to, insert: found.replacement },
            selection: { anchor: from + found.replacement.length },
          });
        });
      }
    },
  );
}

// Re-exported so App.tsx only needs one import site for the editor-facing
// pieces of this feature.
export type { TemplateContext };
export { EditorView };
