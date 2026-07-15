import { useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";

/**
 * Phase 0 scaffold: the three-pane skeleton so we can wire up features
 * incrementally without shuffling top-level layout later.
 *
 *   [ File tree ][ Editor + tabs ][ Preview ]
 *
 * File tree and preview are placeholders. Editor is a bare CodeMirror 6
 * instance with the Markdown language extension — no Live Preview
 * decorations or theming logic yet, that lands in Phase 2.
 */
export default function App() {
  const [value, setValue] = useState(HELLO_MARKDOWN);
  const prefersDark = typeof window !== "undefined"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;

  return (
    <div className="flex h-screen text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-950">
      {/* Left: workspace file tree (placeholder) */}
      <aside className="w-64 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 p-3 overflow-y-auto">
        <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">
          Workspace
        </div>
        <div className="text-sm text-slate-400 italic">
          No folder opened yet.
        </div>
      </aside>

      {/* Center: tab bar + editor */}
      <main className="flex-1 min-w-0 flex flex-col">
        <div className="h-9 border-b border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900 flex items-center px-3 text-sm text-slate-500">
          untitled.md
        </div>
        <div className="flex-1 min-h-0 overflow-hidden">
          <CodeMirror
            value={value}
            onChange={(v) => setValue(v)}
            extensions={[markdown()]}
            theme={prefersDark ? oneDark : "light"}
            height="100%"
            style={{ height: "100%" }}
            basicSetup={{
              lineNumbers: true,
              highlightActiveLine: true,
              foldGutter: false,
            }}
          />
        </div>
      </main>

      {/* Right: rendered preview (placeholder) */}
      <aside className="w-96 shrink-0 border-l border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 p-3 overflow-y-auto">
        <div className="text-xs uppercase tracking-wide text-slate-500 mb-2">
          Preview
        </div>
        <pre className="text-sm whitespace-pre-wrap font-mono text-slate-600 dark:text-slate-400">
{value}
        </pre>
      </aside>
    </div>
  );
}

const HELLO_MARKDOWN = `# Welcome to KotoShelf

Phase 0 scaffold. The three panes above are ready but empty:

- **Left**: workspace file tree — planned Phase 1.
- **Middle**: CodeMirror 6 editor — Markdown Live Preview lands Phase 2.
- **Right**: rendered Markdown preview — Phase 3.

Type here to see the editor working. Preview is just showing the raw
text for now.
`;
