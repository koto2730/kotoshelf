import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { EditorView } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { redo, selectAll, undo } from "@codemirror/commands";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { livePreview } from "./editor/livePreview";
import { wikiLinkExtension } from "./editor/wikilink";
import { editorInteractions } from "./editor/interactions";
import { templateExpansion } from "./editor/templateExpansion";
import type { TemplateContext } from "./lib/templateVars";
import { FileTree } from "./components/FileTree";
import { TabBar } from "./components/TabBar";
import { PreviewPane } from "./components/PreviewPane";
import { InputModal, ListPickerModal, SaveFirstModal } from "./components/Modals";
import { ContextMenu, type MenuAction } from "./components/ContextMenu";
import { SearchPanel, type SearchOpenTarget } from "./components/SearchPanel";
import {
  copyInto,
  createDir,
  flattenTree,
  getInitialTarget,
  pickWorkspaceFolder,
  readFile,
  readTree,
  renamePath,
  trashPath,
  writeBase64File,
  writeFile,
  type TreeNode,
} from "./lib/fs";
import {
  ATTACHMENTS_DIR,
  dirname,
  fileToBase64,
  isImagePath,
  joinPath,
  timestampImageStem,
} from "./lib/attachments";
import {
  isDirty,
  makeFileTab,
  makeUntitledTab,
  basename,
  type Tab,
} from "./lib/tabs";
import { dedup, installAppMenu, type AppCommands } from "./lib/menu";
import { SendPalette } from "./components/SendPalette";
import { SettingsDialog } from "./components/SettingsDialog";
import { getAppConfig, sendRequest, type ApiPreset } from "./lib/apiPresets";
import { renderTemplate } from "./lib/apiTemplateRenderer";
import { extractJsonPath } from "./lib/jsonPath";
import {
  BUILTIN_LIGHT,
  getSelectedTheme,
  resolveTheme,
  setSelectedTheme,
  type ResolvedTheme,
} from "./lib/theme";
import { ThemeDialog } from "./components/ThemeDialog";
import { RemoteWorkspaceDialog } from "./components/RemoteWorkspaceDialog";
import { sshReadTree, sshReadFile, sshWriteFile, sshOpenTerminal, type SshProfile } from "./lib/ssh";

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
  /** Clipboard image waiting for an Untitled tab to be saved first. */
  const [pendingImage, setPendingImage] = useState<File | null>(null);
  /** Wiki-link candidates when [[target]] matches several notes. */
  const [wikiChoices, setWikiChoices] = useState<
    { label: string; detail: string; value: string }[] | null
  >(null);
  /** Tree context menu (right-click on a node or the tree background). */
  const [treeMenu, setTreeMenu] = useState<{
    x: number;
    y: number;
    node: TreeNode | null;
  } | null>(null);
  /** Pending name prompt for tree operations. */
  const [namePrompt, setNamePrompt] = useState<{
    title: string;
    initial?: string;
    onSubmit: (value: string) => void;
  } | null>(null);

  const editorViewRef = useRef<EditorView | null>(null);
  const [leftPane, setLeftPane] = useState<"files" | "search">("files");
  const [sendPaletteOpen, setSendPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [apiPresets, setApiPresets] = useState<ApiPreset[]>([]);
  const [sendBusy, setSendBusy] = useState(false);
  const [themeDialogOpen, setThemeDialogOpen] = useState(false);
  // ---- remote (SSH) workspace (Phase 8) --------------------------------
  const [workspaceKind, setWorkspaceKind] = useState<"local" | "ssh">("local");
  const [sshProfile, setSshProfile] = useState<SshProfile | null>(null);
  const [remoteDialogOpen, setRemoteDialogOpen] = useState(false);
  /** {line, col, len} to select once the target tab's editor is mounted
   * and active - set by a Search-panel result click, consumed by
   * applyPendingJump. A ref (not state) because it must be readable
   * synchronously from onCreateEditor without waiting for a re-render. */
  const pendingJumpRef = useRef<SearchOpenTarget | null>(null);

  // ---- theme (Phase 7) -------------------------------------------------

  // Tracked as state (not read once) so a live OS theme change is
  // reflected immediately when the selection is "system" - matchMedia's
  // change event, not just the value at mount.
  const [systemPrefersDark, setSystemPrefersDark] = useState(
    () => typeof window !== "undefined" &&
      window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const [themeSelection, setThemeSelection] = useState("system");
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(BUILTIN_LIGHT);

  useEffect(() => {
    void getSelectedTheme().then(setThemeSelection);
  }, []);

  useEffect(() => {
    void resolveTheme(themeSelection, systemPrefersDark).then(setResolvedTheme);
  }, [themeSelection, systemPrefersDark]);

  const applyThemeSelection = useCallback(async (name: string) => {
    setThemeSelection(name);
    await setSelectedTheme(name);
  }, []);

  const prefersDark = resolvedTheme.dark;

  const activeTab = activeIndex >= 0 ? tabs[activeIndex] : undefined;
  const fontSize = Math.round((14 * zoom) / 100);

  // Markdown mode (Live Preview + wiki links + GFM + fenced-code
  // highlighting) applies to .md buffers; anything else stays plain.
  const isMarkdownTab = activeTab?.name.toLowerCase().endsWith(".md") ?? false;

  // Callbacks used inside the (memoised) editor extensions go through a
  // ref so the extensions never capture stale state - same pattern as
  // the native-menu commands ref.
  const interactionsRef = useRef<{
    wiki: (target: string) => void;
    imagePaste: (file: File) => void;
  }>({ wiki: () => {}, imagePaste: () => {} });

  // Template-variable context ({{today}}, {{title}}, ...). A ref, not a
  // memo dependency: rebuilding editorExtensions (and therefore
  // remounting CodeMirror) on every keystroke just to keep {{title}}
  // fresh would be absurd. templateExpansion() reads ctxRef.current at
  // expansion time instead.
  const templateCtxRef = useRef<TemplateContext>({
    filename: "",
    workspace: "",
    content: "",
  });
  templateCtxRef.current = {
    filename: activeTab ? activeTab.name.replace(/\.[^.]+$/, "") : "",
    workspace: workspace ? basename(workspace) : "",
    content: activeTab?.content ?? "",
  };

  const editorExtensions = useMemo(() => {
    if (!isMarkdownTab) return [];
    return [
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: [wikiLinkExtension],
      }),
      livePreview(resolvedTheme),
      templateExpansion(templateCtxRef),
      editorInteractions({
        onWikiLink: (target) => interactionsRef.current.wiki(target),
        onStatus: setStatus,
        onImagePaste: (file) => interactionsRef.current.imagePaste(file),
      }),
    ];
    // templateCtxRef is a stable ref identity - intentionally excluded.
    // resolvedTheme is intentionally a dependency: a theme switch should
    // re-render Live Preview's colors immediately, same as any other
    // markdown-mode extension change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isMarkdownTab, resolvedTheme]);

  // ---- workspace ----------------------------------------------------

  // `root` is only used for the local branch - an SSH workspace's root is
  // `sshProfile.remotePath`, tracked separately - but every caller already
  // has the local path handy, so keeping one signature for both branches
  // avoids threading a second "which root" argument through every call site.
  const refreshTree = useCallback(
    async (root: string) => {
      try {
        if (workspaceKind === "ssh" && sshProfile) {
          const config = await getAppConfig();
          setTree(await sshReadTree(sshProfile, config.sshCommandPath));
        } else {
          setTree(await readTree(root));
        }
      } catch (e) {
        setStatus(`Failed to read workspace: ${e}`);
      }
    },
    [workspaceKind, sshProfile],
  );

  const openWorkspaceAt = useCallback(
    async (path: string) => {
      setWorkspaceKind("local");
      setSshProfile(null);
      setWorkspace(path);
      await refreshTree(path);
      setStatus(`Workspace: ${path}`);
    },
    [refreshTree],
  );

  const openFolder = useCallback(async () => {
    const picked = await pickWorkspaceFolder();
    if (!picked) return;
    await openWorkspaceAt(picked);
  }, [openWorkspaceAt]);

  const openSshWorkspace = useCallback(async (profile: SshProfile) => {
    setWorkspaceKind("ssh");
    setSshProfile(profile);
    setWorkspace(profile.remotePath);
    try {
      const config = await getAppConfig();
      setTree(await sshReadTree(profile, config.sshCommandPath));
      const target = profile.user ? `${profile.user}@${profile.host}` : profile.host;
      setStatus(`Workspace (SSH): ${target}:${profile.remotePath}`);
    } catch (e) {
      setStatus(`Failed to read remote workspace: ${e}`);
    }
  }, []);

  const openSshTerminal = useCallback(async () => {
    if (!(workspaceKind === "ssh" && sshProfile)) {
      setStatus("Open a remote (SSH) folder first");
      return;
    }
    try {
      const config = await getAppConfig();
      await sshOpenTerminal(sshProfile, config.sshCommandPath);
    } catch (e) {
      setStatus(`Failed to open terminal: ${e}`);
    }
  }, [workspaceKind, sshProfile]);

  // ---- tabs ----------------------------------------------------------

  const openFile = useCallback(
    async (path: string) => {
      const existing = tabs.findIndex((t) => t.path === path);
      if (existing >= 0) {
        setActiveIndex(existing);
        return;
      }
      try {
        const content =
          workspaceKind === "ssh" && sshProfile
            ? await sshReadFile(sshProfile, (await getAppConfig()).sshCommandPath, path)
            : await readFile(path);
        setTabs((prev) => [...prev, makeFileTab(path, content)]);
        setActiveIndex(tabs.length);
      } catch (e) {
        setStatus(`${e}`);
      }
    },
    [tabs, workspaceKind, sshProfile],
  );

  /** Apply pendingJumpRef to the live editor, if the active tab matches
   * and the view is mounted. Called both from onCreateEditor (new-tab
   * case, where CM just mounted) and from an effect keyed on the active
   * tab (already-open-tab case, where no remount happens so
   * onCreateEditor never fires again). */
  const applyPendingJump = useCallback(() => {
    const jump = pendingJumpRef.current;
    const view = editorViewRef.current;
    if (!jump || !view || activeTab?.path !== jump.path) return;
    try {
      const doc = view.state.doc;
      const lineInfo = doc.line(Math.min(Math.max(jump.line, 1), doc.lines));
      const from = lineInfo.from + Math.min(jump.col, lineInfo.length);
      const to = Math.min(from + jump.len, lineInfo.to);
      view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
      view.focus();
    } catch {
      // Line/col out of range (file changed since search ran) - ignore.
    }
    pendingJumpRef.current = null;
  }, [activeTab?.path]);

  useEffect(() => {
    applyPendingJump();
  }, [applyPendingJump]);

  const handleSearchOpenMatch = useCallback(
    async (target: SearchOpenTarget) => {
      pendingJumpRef.current = target;
      await openFile(target.path);
      // Covers the "already open, no remount" case; the effect above
      // covers the "just mounted a new tab" case.
      applyPendingJump();
    },
    [openFile, applyPendingJump],
  );

  // `kotoshelf .` / `kotoshelf notes.md` on the command line. Runs once on
  // mount; a plain launch (no usable arg) resolves to null and is a no-op.
  useEffect(() => {
    void getInitialTarget().then((target) => {
      if (!target) return;
      if (target.kind === "workspace") {
        void openWorkspaceAt(target.path);
      } else {
        void openWorkspaceAt(target.workspace).then(() => openFile(target.path));
      }
    });
    // Deliberately empty deps: this is a one-shot "what did the shell
    // launch us with" check, not something that should re-run when
    // openWorkspaceAt/openFile identities change on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
  /** Save the active tab. Returns the saved path, or null when the user
   * cancelled the dialog / nothing to save / write failed - callers like
   * the save-then-attach flow need to know whether to continue. */
  const saveActive = useCallback(
    async (forceDialog = false): Promise<string | null> => {
      const tab = activeIndex >= 0 ? tabs[activeIndex] : undefined;
      if (!tab) return null;
      let targetPath = tab.path;

      // SSH workspaces can't use the native save dialog - it only sees
      // the local filesystem - so a new/renamed remote file is named via
      // a plain prompt() instead. Editing an already-open remote file
      // (the common case) never hits this branch's dialog at all.
      if (workspaceKind === "ssh" && sshProfile) {
        if (forceDialog || targetPath === null) {
          const picked = window.prompt(
            "Save as (path relative to the remote workspace folder):",
            targetPath ?? tab.name,
          );
          if (!picked) return null;
          targetPath = picked;
        }
        try {
          const config = await getAppConfig();
          await sshWriteFile(sshProfile, config.sshCommandPath, targetPath, tab.content);
          setTabs((prev) =>
            prev.map((t, i) =>
              i === activeIndex
                ? { ...t, path: targetPath, name: basename(targetPath!), savedContent: t.content }
                : t,
            ),
          );
          setStatus(`Saved ${basename(targetPath)} (SSH)`);
          void refreshTree(workspace ?? "");
          return targetPath;
        } catch (e) {
          setStatus(`${e}`);
          return null;
        }
      }

      if (forceDialog || targetPath === null) {
        const picked = await saveDialog({
          defaultPath: workspace ? `${workspace}/${tab.name}` : tab.name,
          filters: [
            { name: "Markdown", extensions: ["md"] },
            { name: "All files", extensions: ["*"] },
          ],
        });
        if (!picked) return null;
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
        return targetPath;
      } catch (e) {
        setStatus(`${e}`);
        return null;
      }
    },
    [activeIndex, tabs, workspace, workspaceKind, sshProfile, refreshTree],
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

  // ---- attachments (paste / drag & drop) -----------------------------

  const insertAtCursor = useCallback((text: string) => {
    const view = editorViewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: text },
      selection: { anchor: sel.from + text.length },
    });
  }, []);

  const attachImageToPath = useCallback(
    async (tabPath: string, file: File) => {
      try {
        const dir = joinPath(dirname(tabPath), ATTACHMENTS_DIR);
        const ext = file.type.startsWith("image/")
          ? (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg")
          : "png";
        const name = `${timestampImageStem()}.${ext}`;
        await writeBase64File(joinPath(dir, name), await fileToBase64(file));
        insertAtCursor(`![](${ATTACHMENTS_DIR}/${name})`);
        setStatus(`Attached ${name}`);
        if (workspace) void refreshTree(workspace);
      } catch (e) {
        setStatus(`${e}`);
      }
    },
    [insertAtCursor, workspace, refreshTree],
  );

  const handleImagePaste = useCallback(
    (file: File) => {
      const tab = activeIndex >= 0 ? tabs[activeIndex] : undefined;
      if (!tab) return;
      if (tab.path === null) {
        setPendingImage(file);
        return;
      }
      void attachImageToPath(tab.path, file);
    },
    [activeIndex, tabs, attachImageToPath],
  );

  const saveNowForPending = useCallback(async () => {
    const file = pendingImage;
    setPendingImage(null);
    if (!file) return;
    const savedPath = await saveActive();
    if (savedPath) await attachImageToPath(savedPath, file);
  }, [pendingImage, saveActive, attachImageToPath]);

  // OS file drops arrive via Tauri's drag-drop event (the webview's own
  // HTML5 drop is intercepted by Tauri when dragDropEnabled, the
  // default). Images copy into the attachments folder + insert a
  // reference; anything else opens as a tab.
  const dropRef = useRef<(paths: string[]) => void>(() => {});
  dropRef.current = (paths) => {
    for (const p of paths) {
      if (isImagePath(p)) {
        const tab = activeIndex >= 0 ? tabs[activeIndex] : undefined;
        if (!tab) {
          setStatus("Open a tab before dropping images.");
          continue;
        }
        if (tab.path === null) {
          setStatus("Save this file first to attach dropped images.");
          continue;
        }
        const destDir = joinPath(dirname(tab.path), ATTACHMENTS_DIR);
        const name = `${timestampImageStem()}-${basename(p)}`;
        void copyInto(p, destDir, name)
          .then(() => {
            insertAtCursor(`![](${ATTACHMENTS_DIR}/${name})`);
            setStatus(`Attached ${name}`);
            if (workspace) void refreshTree(workspace);
          })
          .catch((e) => setStatus(`${e}`));
      } else {
        void openFile(p);
      }
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") dropRef.current(event.payload.paths);
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  // ---- wiki links -----------------------------------------------------

  const resolveWikiLink = useCallback(
    (target: string) => {
      if (!workspace) {
        setStatus("Open a workspace to resolve wiki links.");
        return;
      }
      const t = target.toLowerCase();
      const matches = flattenTree(tree).filter(
        (n) =>
          !n.isDir &&
          (n.name.toLowerCase() === `${t}.md` || n.name.toLowerCase() === t),
      );
      if (matches.length === 1) {
        void openFile(matches[0].path);
        return;
      }
      if (matches.length > 1) {
        setWikiChoices(
          matches.map((m) => ({ label: m.name, detail: m.path, value: m.path })),
        );
        return;
      }
      // No match: create the note, Obsidian-style. It lands next to the
      // current file (workspace root for untitled buffers) and opens
      // immediately so the link becomes valid the moment it's clicked.
      const fileName = t.endsWith(".md") ? target : `${target}.md`;
      const tab = activeIndex >= 0 ? tabs[activeIndex] : undefined;
      const dir = tab?.path ? dirname(tab.path) : workspace;
      const newPath = joinPath(dir, fileName);
      void (async () => {
        try {
          await writeFile(newPath, "");
          await refreshTree(workspace);
          await openFile(newPath);
          setStatus(`Created ${fileName}`);
        } catch (e) {
          setStatus(`${e}`);
        }
      })();
    },
    [workspace, tree, openFile, activeIndex, tabs, refreshTree],
  );

  // Keep the editor-extension callbacks fresh (see interactionsRef).
  interactionsRef.current = { wiki: resolveWikiLink, imagePaste: handleImagePaste };

  // ---- tree operations (context menu) ---------------------------------

  /** Directory a "new file/folder here" operation should target. */
  const menuTargetDir = useCallback(
    (node: TreeNode | null): string | null => {
      if (!workspace) return null;
      if (!node) return workspace;
      return node.isDir ? node.path : dirname(node.path);
    },
    [workspace],
  );

  const treeMenuActions = useCallback(
    (node: TreeNode | null): MenuAction[] => {
      const dir = menuTargetDir(node);
      if (!dir || !workspace) return [];
      const actions: MenuAction[] = [
        {
          label: "New File…",
          onClick: () =>
            setNamePrompt({
              title: `New file in ${basename(dir)}/`,
              onSubmit: (name) => {
                const p = joinPath(dir, name);
                void writeFile(p, "")
                  .then(() => refreshTree(workspace))
                  .then(() => openFile(p))
                  .catch((e) => setStatus(`${e}`));
              },
            }),
        },
        {
          label: "New Folder…",
          onClick: () =>
            setNamePrompt({
              title: `New folder in ${basename(dir)}/`,
              onSubmit: (name) => {
                void createDir(joinPath(dir, name))
                  .then(() => refreshTree(workspace))
                  .catch((e) => setStatus(`${e}`));
              },
            }),
        },
      ];
      if (node) {
        actions.push(
          {
            label: "Rename…",
            onClick: () =>
              setNamePrompt({
                title: `Rename ${node.name}`,
                initial: node.name,
                onSubmit: (name) => {
                  const to = joinPath(dirname(node.path), name);
                  void renamePath(node.path, to)
                    .then(() => {
                      // Follow the rename in any open tabs (files directly,
                      // and everything under a renamed folder by prefix).
                      setTabs((prev) =>
                        prev.map((t) => {
                          if (!t.path) return t;
                          if (t.path === node.path) {
                            return { ...t, path: to, name: basename(to) };
                          }
                          if (t.path.startsWith(node.path + "/") ||
                              t.path.startsWith(node.path + "\\")) {
                            const suffix = t.path.slice(node.path.length);
                            return { ...t, path: to + suffix };
                          }
                          return t;
                        }),
                      );
                      return refreshTree(workspace);
                    })
                    .catch((e) => setStatus(`${e}`));
                },
              }),
          },
          {
            label: "Delete (to trash)",
            danger: true,
            onClick: () => {
              if (!window.confirm(`Move "${node.name}" to the trash?`)) return;
              void trashPath(node.path)
                .then(() => {
                  setStatus(`Moved ${node.name} to trash`);
                  return refreshTree(workspace);
                })
                .catch((e) => setStatus(`${e}`));
              // Tabs pointing at the deleted path stay open (VS Code
              // behaviour) - saving them recreates the file.
            },
          },
        );
      }
      return actions;
    },
    [menuTargetDir, workspace, refreshTree, openFile],
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

  // ---- API presets / Send palette (Phase 6) ---------------------------

  // Loaded once on mount and refreshed whenever Settings closes, so a
  // freshly-added preset shows up in the palette without a restart.
  const reloadApiPresets = useCallback(() => {
    void getAppConfig().then((config) => setApiPresets(config.presets));
  }, []);

  useEffect(() => {
    reloadApiPresets();
  }, [reloadApiPresets]);

  const sendWithPreset = useCallback(
    async (preset: ApiPreset) => {
      setSendPaletteOpen(false);
      const view = editorViewRef.current;
      const tab = activeTab;
      if (!view || !tab || sendBusy) return;
      const sel = view.state.selection.main;
      const selectionText = sel.empty
        ? view.state.doc.toString()
        : view.state.sliceDoc(sel.from, sel.to);

      setSendBusy(true);
      setStatus(`Sending to '${preset.name}'…`);
      try {
        const config = await getAppConfig();
        const ctx = {
          selection: selectionText,
          filename: tab.name.replace(/\.[^.]+$/, ""),
          tokens: config.tokens,
        };
        const url = renderTemplate(preset.url, ctx);
        const body = preset.bodyTemplate
          ? renderTemplate(preset.bodyTemplate, ctx)
          : null;
        const headers: [string, string][] = preset.headers.map(([k, v]) => [
          k,
          renderTemplate(v, ctx),
        ]);

        const response = await sendRequest({ url, method: preset.method, headers, body });
        if (response.status < 200 || response.status >= 300) {
          setStatus(`Send failed: HTTP ${response.status}`);
          return;
        }
        const extracted = preset.responseJsonPath
          ? extractJsonPath(response.body, preset.responseJsonPath) ?? response.body
          : response.body;

        if (preset.responseTarget === "newTab") {
          const newTab = makeUntitledTab();
          newTab.content = extracted;
          setTabs((prev) => [...prev, newTab]);
          setActiveIndex(tabs.length);
        } else if (preset.responseTarget === "afterSelection") {
          const end = sel.to;
          const needsNewlineBefore =
            end > 0 && view.state.sliceDoc(end - 1, end) !== "\n";
          const needsNewlineAfter = !extracted.endsWith("\n");
          const payload =
            (needsNewlineBefore ? "\n" : "") +
            extracted +
            (needsNewlineAfter ? "\n" : "");
          view.dispatch({ changes: { from: end, to: end, insert: payload } });
          onEdit(view.state.doc.toString());
        }
        // "statusOnly" falls through to just the status-bar message below.
        setStatus(`Send OK (${response.status})`);
      } catch (e) {
        setStatus(`Send failed: ${e}`);
      } finally {
        setSendBusy(false);
      }
    },
    [activeTab, sendBusy, tabs.length, onEdit],
  );

  // ---- command surface for the native menu ---------------------------

  const commandsRef = useRef<AppCommands>(null as unknown as AppCommands);
  commandsRef.current = {
    newFile,
    openFolder: () => void openFolder(),
    openRemoteWorkspace: () => setRemoteDialogOpen(true),
    openSshTerminal: () => void openSshTerminal(),
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
    openSendPalette: () => setSendPaletteOpen(true),
    openSettings: () => setSettingsOpen(true),
    openThemeDialog: () => setThemeDialogOpen(true),
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
      } else if (e.key === ";") {
        e.preventDefault();
        dedup("openSendPalette", c.openSendPalette);
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () =>
      window.removeEventListener("keydown", handler, { capture: true });
  }, []);

  // ---- render ---------------------------------------------------------

  return (
    <div className="flex h-screen text-slate-900 dark:text-slate-100 bg-white dark:bg-slate-950">
      {/* Left: workspace file tree / search */}
      <aside className="w-72 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 flex flex-col">
        {workspace && (
          <div className="flex border-b border-slate-200 dark:border-slate-800">
            <button
              type="button"
              className={
                "flex-1 text-xs uppercase tracking-wide py-1.5 " +
                (leftPane === "files"
                  ? "border-b-2 border-blue-500 text-slate-900 dark:text-slate-100"
                  : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300")
              }
              onClick={() => setLeftPane("files")}
            >
              Files
            </button>
            <button
              type="button"
              className={
                "flex-1 text-xs uppercase tracking-wide py-1.5 " +
                (leftPane === "search"
                  ? "border-b-2 border-blue-500 text-slate-900 dark:text-slate-100"
                  : "text-slate-400 hover:text-slate-600 dark:hover:text-slate-300")
              }
              onClick={() => setLeftPane("search")}
            >
              Search
            </button>
          </div>
        )}
        {leftPane === "search" && workspace ? (
          <SearchPanel
            workspace={workspace}
            onOpenMatch={(target) => void handleSearchOpenMatch(target)}
            onStatus={setStatus}
          />
        ) : (
          <>
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
            <div
              className="flex-1 overflow-y-auto p-2"
              onContextMenu={(e) => {
                // Right-click on the tree background = workspace-root menu.
                // Node rows stopPropagation, so this only fires on empty space.
                if (!workspace) return;
                e.preventDefault();
                setTreeMenu({ x: e.clientX, y: e.clientY, node: null });
              }}
            >
              {workspace ? (
                <FileTree
                  nodes={tree}
                  onOpenFile={(p) => void openFile(p)}
                  activePath={activeTab?.path ?? null}
                  onNodeMenu={(node, x, y) => setTreeMenu({ x, y, node })}
                />
              ) : (
                <div className="text-sm text-slate-400 italic p-1">
                  No folder opened yet.
                </div>
              )}
            </div>
          </>
        )}
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
                applyPendingJump();
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
          <PreviewPane
            content={activeTab?.content ?? ""}
            fileDir={activeTab?.path ? dirname(activeTab.path) : null}
          />
        ) : (
          <pre className="text-sm whitespace-pre-wrap font-mono text-slate-600 dark:text-slate-400 p-3">
            {activeTab?.content ?? ""}
          </pre>
        )}
      </aside>

      {pendingImage && (
        <SaveFirstModal
          onSaveNow={() => void saveNowForPending()}
          onClose={() => setPendingImage(null)}
        />
      )}
      {wikiChoices && (
        <ListPickerModal
          title="Multiple notes match this wiki link"
          items={wikiChoices}
          onPick={(path) => {
            setWikiChoices(null);
            void openFile(path);
          }}
          onClose={() => setWikiChoices(null)}
        />
      )}
      {treeMenu && (
        <ContextMenu
          x={treeMenu.x}
          y={treeMenu.y}
          actions={treeMenuActions(treeMenu.node)}
          onClose={() => setTreeMenu(null)}
        />
      )}
      {namePrompt && (
        <InputModal
          title={namePrompt.title}
          initial={namePrompt.initial}
          onSubmit={namePrompt.onSubmit}
          onClose={() => setNamePrompt(null)}
        />
      )}
      {sendPaletteOpen && (
        <SendPalette
          presets={apiPresets}
          onPick={(preset) => void sendWithPreset(preset)}
          onClose={() => setSendPaletteOpen(false)}
        />
      )}
      {settingsOpen && (
        <SettingsDialog
          onClose={() => {
            setSettingsOpen(false);
            reloadApiPresets();
          }}
        />
      )}
      {themeDialogOpen && (
        <ThemeDialog
          selection={themeSelection}
          onSelect={(name) => void applyThemeSelection(name)}
          onClose={() => setThemeDialogOpen(false)}
        />
      )}
      {remoteDialogOpen && (
        <RemoteWorkspaceDialog
          onConnect={(profile) => {
            setRemoteDialogOpen(false);
            void openSshWorkspace(profile);
          }}
          onClose={() => setRemoteDialogOpen(false)}
        />
      )}
    </div>
  );
}
