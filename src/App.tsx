import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { redo, selectAll, undo } from "@codemirror/commands";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { livePreview } from "./editor/livePreview";
import { wikiLinkExtension } from "./editor/wikilink";
import { editorInteractions } from "./editor/interactions";
import { FileTree } from "./components/FileTree";
import { TabBar } from "./components/TabBar";
import { PreviewPane } from "./components/PreviewPane";
import {
  pickWorkspaceFolder,
  readFile,
  readTree,
  writeFile,
  type TreeNode,
} from "./lib/fs";
import {
  isDirty,
  makeFileTab,
  makeUntitledTab,
  basename,
  type Tab,
} from "./lib/tabs";
import { dedup, installAppMenu, type AppCommands } from "./lib/menu";

/**
 * Phase 1: workspace + file tree + tabs + native menu.
 *
 *   [ File tree ][ Editor + tabs ][ Preview (placeholder) ]
 *
 * The native menu (File/Edit/View, kotomemo-style) drives commands via a
 * ref so menu closures always see the latest state. Keyboard chords are
 * ALSO handled by a webview keydown listener as a fallback; the dedup()
 * window in lib/menu.ts stops double-firing when both paths trigger.
 */
export default function App() {
  const [workspace, setWorkspace] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [status, setStatus] = useState<string | null>(null);
  const [zoom, setZoom] = useState(100);

  const editorViewRef = useRef<EditorView | null>(null);

  const prefersDark =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches;

  const activeTab = activeIndex >= 0 ? tabs[activeIndex] : undefined;
  const fontSize = Math.round((14 * zoom) / 100);

  // Markdown mode (Live Preview + wiki links + GFM + fenced-code
  // highlighting) applies to .md buffers; anything else stays plain.
  const isMarkdownTab = activeTab?.name.toLowerCase().endsWith(".md") ?? false;
  const editorExtensions = useMemo(() => {
    if (!isMarkdownTab) return [];
    return [
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: [wikiLinkExtension],
      }),
      livePreview(),
      editorInteractions({
        onWikiLink: (target) =>
          setStatus(`[[${target}]] — wiki link resolution lands in Phase 3`),
        onStatus: setStatus,
      }),
    ];
  }, [isMarkdownTab]);

  // ---- workspace ----------------------------------------------------

  const refreshTree = useCallback(async (root: string) => {
    try {
      setTree(await readTree(root));
    } catch (e) {
      setStatus(`Failed to read workspace: ${e}`);
    }
  }, []);

  const openFolder = useCallback(async () => {
    const picked = await pickWorkspaceFolder();
    if (!picked) return;
    setWorkspace(picked);
    await refreshTree(picked);
    setStatus(`Workspace: ${picked}`);
  }, [refreshTree]);

  // ---- tabs ----------------------------------------------------------

  const openFile = useCallback(
    async (path: string) => {
      const existing = tabs.findIndex((t) => t.path === path);
      if (existing >= 0) {
        setActiveIndex(existing);
        return;
      }
      try {
        const content = await readFile(path);
        setTabs((prev) => [...prev, makeFileTab(path, content)]);
        setActiveIndex(tabs.length);
      } catch (e) {
        setStatus(`${e}`);
      }
    },
    [tabs],
  );

  const newFile = useCallback(() => {
    setTabs((prev) => [...prev, makeUntitledTab()]);
    setActiveIndex(tabs.length);
  }, [tabs.length]);

  const onEdit = useCallback(
    (value: string) => {
      setTabs((prev) =>
        prev.map((t, i) => (i === activeIndex ? { ...t, content: value } : t)),
      );
    },
    [activeIndex],
  );

  /**
   * Save the active tab. Untitled buffers (path === null) route through
   * the native save dialog; picking a location inside the workspace also
   * refreshes the tree so the new file appears immediately.
   */
  const saveActive = useCallback(
    async (forceDialog = false) => {
      const tab = activeIndex >= 0 ? tabs[activeIndex] : undefined;
      if (!tab) return;
      let targetPath = tab.path;
      if (forceDialog || targetPath === null) {
        const picked = await saveDialog({
          defaultPath: workspace ? `${workspace}/${tab.name}` : tab.name,
          filters: [
            { name: "Markdown", extensions: ["md"] },
            { name: "All files", extensions: ["*"] },
          ],
        });
        if (!picked) return;
        targetPath = picked;
      }
      try {
        await writeFile(targetPath, tab.content);
        setTabs((prev) =>
          prev.map((t, i) =>
            i === activeIndex
              ? {
                  ...t,
                  path: targetPath,
                  name: basename(targetPath!),
                  savedContent: t.content,
                }
              : t,
          ),
        );
        setStatus(`Saved ${basename(targetPath)}`);
        if (workspace) void refreshTree(workspace);
      } catch (e) {
        setStatus(`${e}`);
      }
    },
    [activeIndex, tabs, workspace, refreshTree],
  );

  const closeTab = useCallback(
    (index: number) => {
      const tab = tabs[index];
      if (!tab) return;
      if (isDirty(tab)) {
        const ok = window.confirm(
          `${tab.name} has unsaved changes. Close anyway?`,
        );
        if (!ok) return;
      }
      setTabs((prev) => prev.filter((_, i) => i !== index));
      setActiveIndex((prev) => {
        if (index < prev) return prev - 1;
        if (index === prev) return Math.min(prev, tabs.length - 2);
        return prev;
      });
    },
    [tabs],
  );

  // ---- clipboard (menu-driven; keyboard chords are native) -----------

  const clipboardCut = useCallback(async () => {
    const view = editorViewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    const text = view.state.sliceDoc(sel.from, sel.to);
    try {
      await navigator.clipboard.writeText(text);
      view.dispatch({ changes: { from: sel.from, to: sel.to, insert: "" } });
    } catch {
      setStatus("Clipboard unavailable");
    }
  }, []);

  const clipboardCopy = useCallback(async () => {
    const view = editorViewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) return;
    try {
      await navigator.clipboard.writeText(view.state.sliceDoc(sel.from, sel.to));
    } catch {
      setStatus("Clipboard unavailable");
    }
  }, []);

  const clipboardPaste = useCallback(async () => {
    const view = editorViewRef.current;
    if (!view) return;
    try {
      const text = await navigator.clipboard.readText();
      if (!text) return;
      const sel = view.state.selection.main;
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
      });
    } catch {
      setStatus("Clipboard unavailable");
    }
  }, []);

  // ---- command surface for the native menu ---------------------------

  const commandsRef = useRef<AppCommands>(null as unknown as AppCommands);
  commandsRef.current = {
    newFile,
    openFolder: () => void openFolder(),
    save: () => void saveActive(),
    saveAs: () => void saveActive(true),
    closeActiveTab: () => closeTab(activeIndex),
    exit: () => void getCurrentWindow().close(),
    undo: () => {
      const v = editorViewRef.current;
      if (v) undo(v);
    },
    redo: () => {
      const v = editorViewRef.current;
      if (v) redo(v);
    },
    cut: () => void clipboardCut(),
    copy: () => void clipboardCopy(),
    paste: () => void clipboardPaste(),
    selectAll: () => {
      const v = editorViewRef.current;
      if (v) selectAll(v);
    },
    zoomIn: () => setZoom((z) => Math.min(z + 10, 300)),
    zoomOut: () => setZoom((z) => Math.max(z - 10, 50)),
    zoomReset: () => setZoom(100),
  };

  useEffect(() => {
    void installAppMenu(commandsRef).catch((e) =>
      setStatus(`Menu setup failed: ${e}`),
    );
    // Menu installs once; actions read commandsRef.current for fresh state.
  }, []);

  // Webview-side fallback for chords the native accelerator may not
  // deliver (platform differences). dedup() prevents double handling.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const c = commandsRef.current;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        dedup(e.shiftKey ? "saveAs" : "save", e.shiftKey ? c.saveAs : c.save);
      } else if (key === "n") {
        e.preventDefault();
        dedup("newFile", c.newFile);
      } else if (key === "w") {
        e.preventDefault();
        dedup("closeActiveTab", c.closeActiveTab);
      } else if (key === "o" && e.shiftKey) {
        e.preventDefault();
        dedup("openFolder", c.openFolder);
      } else if (key === "=" || key === "+") {
        e.preventDefault();
        dedup("zoomIn", c.zoomIn);
      } else if (key === "-") {
        e.preventDefault();
        dedup("zoomOut", c.zoomOut);
      } else if (key === "0") {
        e.preventDefault();
        dedup("zoomReset", c.zoomReset);
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, []);

  // ---- render ---------------------------------------------------------

  return (
    <div className="flex h-screen text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-950">
      {/* Left: workspace file tree */}
      <aside className="w-64 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 flex flex-col">
        <div className="p-2 flex items-center gap-1 border-b border-slate-200 dark:border-slate-800">
          <button
            type="button"
            className="flex-1 text-sm rounded bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 px-2 py-1"
            onClick={() => void openFolder()}
          >
            Open Folder…
          </button>
          <button
            type="button"
            className="text-sm rounded bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 px-2 py-1"
            title="New file (Ctrl+N)"
            onClick={newFile}
          >
            ＋
          </button>
          {workspace && (
            <button
              type="button"
              className="text-sm rounded bg-slate-200 dark:bg-slate-800 hover:bg-slate-300 dark:hover:bg-slate-700 px-2 py-1"
              title="Refresh tree"
              onClick={() => void refreshTree(workspace)}
            >
              ⟳
            </button>
          )}
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {workspace ? (
            <FileTree
              nodes={tree}
              onOpenFile={(p) => void openFile(p)}
              activePath={activeTab?.path ?? null}
            />
          ) : (
            <div className="text-sm text-slate-400 italic p-1">
              No folder opened yet.
            </div>
          )}
        </div>
      </aside>

      {/* Center: tab bar + editor */}
      <main className="flex-1 min-w-0 flex flex-col">
        <TabBar
          tabs={tabs}
          activeIndex={activeIndex}
          onSelect={setActiveIndex}
          onClose={closeTab}
        />
        <div className="flex-1 min-h-0 overflow-hidden">
          {activeTab ? (
            <CodeMirror
              // Remount CM per tab so per-file undo history doesn't leak
              // across tabs.
              key={activeTab.id}
              value={activeTab.content}
              onChange={onEdit}
              onCreateEditor={(view) => {
                editorViewRef.current = view;
              }}
              extensions={editorExtensions}
              theme={prefersDark ? oneDark : "light"}
              height="100%"
              style={{ height: "100%", fontSize: `${fontSize}px` }}
              basicSetup={{
                lineNumbers: true,
                highlightActiveLine: true,
                foldGutter: false,
              }}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-slate-400 text-sm">
              Open a folder and click a file, or press Ctrl+N for a new file.
            </div>
          )}
        </div>
        {/* Status bar */}
        <div className="h-6 border-t border-slate-200 dark:border-slate-800 bg-slate-100 dark:bg-slate-900 flex items-center px-3 text-xs text-slate-500 gap-4">
          <span className="truncate">{workspace ?? "—"}</span>
          <span className="ml-auto shrink-0">{zoom}%</span>
          {status && <span className="truncate">{status}</span>}
        </div>
      </main>

      {/* Right: rendered Markdown preview. Relative images + wiki-link
          resolution still pending (Phase 3). */}
      <aside className="w-96 shrink-0 border-l border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 overflow-y-auto">
        <div className="text-xs uppercase tracking-wide text-slate-500 px-3 pt-3">
          Preview
        </div>
        {isMarkdownTab ? (
          <PreviewPane content={activeTab?.content ?? ""} />
        ) : (
          <pre className="text-sm whitespace-pre-wrap font-mono text-slate-600 dark:text-slate-400 p-3">
            {activeTab?.content ?? ""}
          </pre>
        )}
      </aside>
    </div>
  );
}
