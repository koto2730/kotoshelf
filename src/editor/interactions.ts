import { EditorView } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import { openUrl } from "@tauri-apps/plugin-opener";
import { wikiLinkTarget } from "./wikilink";

export interface InteractionHandlers {
  /** [[wiki link]] activated (Ctrl+click). Resolution strategy is the
   * app's concern (workspace lookup + ambiguity menu). */
  onWikiLink: (target: string) => void;
  onStatus: (message: string) => void;
  /** Clipboard image pasted into the editor. The app saves it to the
   * attachments folder and inserts the reference. Text pastes are left
   * to CodeMirror's default handling. */
  onImagePaste?: (file: File) => void;
}

/**
 * Pointer interactions for Live Preview:
 *  - click on a rendered task checkbox toggles [ ] <-> [x] in the text
 *  - Ctrl/Cmd+click on links opens them (URL -> OS browser via the
 *    opener plugin, wiki links -> app callback)
 */
export function editorInteractions(handlers: InteractionHandlers) {
  return EditorView.domEventHandlers({
    paste(event) {
      const items = event.clipboardData?.items;
      if (!items || !handlers.onImagePaste) return false;
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) {
            event.preventDefault();
            handlers.onImagePaste(file);
            return true;
          }
        }
      }
      return false;
    },
    mousedown(event, view) {
      const target = event.target as HTMLElement;

      if (
        target instanceof HTMLInputElement &&
        target.dataset.kotoshelfTask === "1"
      ) {
        const pos = view.posAtDOM(target);
        toggleTaskAt(view, pos);
        event.preventDefault();
        return true;
      }

      if (!(event.ctrlKey || event.metaKey)) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;

      let node: SyntaxNode | null = syntaxTree(view.state).resolveInner(pos, 0);
      while (node) {
        if (node.name === "WikiLink") {
          handlers.onWikiLink(
            wikiLinkTarget(view.state.sliceDoc(node.from, node.to)),
          );
          event.preventDefault();
          return true;
        }
        if (node.name === "Link") {
          const url = node.getChild("URL");
          if (url) {
            const href = view.state.sliceDoc(url.from, url.to);
            openUrl(href).catch((e) => handlers.onStatus(`Open failed: ${e}`));
          }
          event.preventDefault();
          return true;
        }
        if (node.name === "URL") {
          const href = view.state.sliceDoc(node.from, node.to);
          openUrl(href).catch((e) => handlers.onStatus(`Open failed: ${e}`));
          event.preventDefault();
          return true;
        }
        node = node.parent;
      }
      return false;
    },
  });
}

/**
 * Toggle the GFM task marker whose replaced-widget position is `pos`
 * (the widget replaces [marker.from, marker.to+1), so posAtDOM lands on
 * marker.from). Falls back to scanning the line for a marker so a
 * slightly-off position still works.
 */
function toggleTaskAt(view: EditorView, pos: number) {
  const line = view.state.doc.lineAt(pos);
  const match = /\[([ xX])\]/.exec(line.text);
  if (!match) return;
  const from = line.from + match.index;
  const to = from + match[0].length;
  const next = match[1] === " " ? "[x]" : "[ ]";
  view.dispatch({ changes: { from, to, insert: next } });
}
