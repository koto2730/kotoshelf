import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { crosshairCursor, rectangularSelection, type EditorView, type ViewUpdate } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { oneDark } from "@codemirror/theme-one-dark";
import { redo, selectAll, undo } from "@codemirror/commands";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { convertFileSrc } from "@tauri-apps/api/core";
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
import { FindReplaceBar } from "./components/FindReplaceBar";
import { findAllMatches, replaceAllText, initialFindReplaceState, type FindReplaceState } from "./lib/findReplace";
import {
  copyInto,
  createDir,
  flattenTree,
  formatBytes,
  getInitialTarget,
  insertTreeDir,
  insertTreeFile,
  LARGE_FILE_WARN_BYTES,
  pickWorkspaceFolder,
  readFile,
  readTree,
  renamePath,
  trashPath,
  utf8ByteLength,
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
  mimeTypeOf,
  sanitizeAttachmentName,
  timestampImageStem,
} from "./lib/attachments";
import {
  isDirty,
  makeFileTab,
  makeImageTab,
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
import {
  sshReadTree,
  sshReadFile,
  sshReadFileBase64,
  sshWriteFile,
  sshWriteBase64File,
  sshUploadFile,
  sshCreateDir,
  sshRenamePath,
  sshTrashPath,
  sshStatSize,
  sshOpenTerminal,
  type SshProfile,
} from "./lib/ssh";

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
  // Resizable left sidebar (file tree / search) - long filenames or a
  // deeply nested tree get cramped at a fixed width, with no way to see
  // more than a truncated name.
  const [leftPaneWidth, setLeftPaneWidth] = useState(288); // matches the old fixed w-72
  const leftPaneResizing = useRef(false);
  const startLeftPaneResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    leftPaneResizing.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!leftPaneResizing.current) return;
      setLeftPaneWidth(Math.min(600, Math.max(160, ev.clientX)));
    };
    const onUp = () => {
      leftPaneResizing.current = false;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);
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
    // Alt+drag box selection - applies to every buffer, not just
    // Markdown ones, so it lives outside the isMarkdownTab branch below.
    const base = [rectangularSelection(), crosshairCursor()];
    if (!isMarkdownTab) return base;
    return [
      ...base,
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
        // An image file used to get read as text - its raw bytes
        // reinterpreted as UTF-8 into a CodeMirror buffer, i.e. visible
        // mojibake. Route it to a read-only image tab instead.
        if (isImagePath(path)) {
          let imageSrc: string;
          if (workspaceKind === "ssh" && sshProfile) {
            const sshCommandPath = (await getAppConfig()).sshCommandPath;
            const cached = flattenTree(tree).find((n) => n.path === path);
            const size = cached ? cached.size : await sshStatSize(sshProfile, sshCommandPath, path);
            if (size > LARGE_FILE_WARN_BYTES) {
              setStatus(
                `${basename(path)} is ${formatBytes(size)} - too large to open over SSH.`,
              );
              return;
            }
            const base64 = await sshReadFileBase64(sshProfile, sshCommandPath, path);
            imageSrc = `data:${mimeTypeOf(path)};base64,${base64}`;
          } else {
            imageSrc = convertFileSrc(path);
          }
          setTabs((prev) => [...prev, makeImageTab(path, imageSrc)]);
          setActiveIndex(tabs.length);
          return;
        }

        let content: string;
        if (workspaceKind === "ssh" && sshProfile) {
          const sshCommandPath = (await getAppConfig()).sshCommandPath;
          // The tree already carries each file's size from the last
          // listing/save - reuse it rather than a fresh `wc -c` round
          // trip. Only fall back to asking the server when the path
          // isn't in our current snapshot (e.g. changed on the remote
          // side out from under us).
          const cached = flattenTree(tree).find((n) => n.path === path);
          const size = cached ? cached.size : await sshStatSize(sshProfile, sshCommandPath, path);
          // A hard block, not a confirm-to-proceed dialog: a misclick
          // among a lot of listed files needing an app restart is worse
          // than the file simply not opening. The ^ marker in the tree
          // is the warning; this is what makes it actually stick.
          if (size > LARGE_FILE_WARN_BYTES) {
            setStatus(
              `${basename(path)} is ${formatBytes(size)} - too large to open over SSH.`,
            );
            return;
          }
          content = await sshReadFile(sshProfile, sshCommandPath, path);
        } else {
          content = await readFile(path);
        }
        setTabs((prev) => [...prev, makeFileTab(path, content)]);
        setActiveIndex(tabs.length);
      } catch (e) {
        setStatus(`${e}`);
      }
    },
    [tabs, tree, workspaceKind, sshProfile],
  );

  // Preview images have no local file for <img src="file://..."> to load
  // in an SSH workspace, so they're fetched as bytes and shown via a
  // data: URI instead (see components/PreviewPane.tsx). Cached by path
  // so re-rendering the preview (every keystroke elsewhere in the note)
  // doesn't re-fetch an image that hasn't changed; a ref rather than
  // state since it's a cache, not something that should itself trigger
  // a re-render when it's filled in after the fact.
  const sshImageCache = useRef<Map<string, string>>(new Map());
  const resolveSshImage = useCallback(
    async (relPath: string): Promise<string | null> => {
      if (!(workspaceKind === "ssh" && sshProfile)) return null;
      const cached = sshImageCache.current.get(relPath);
      if (cached) return cached;
      try {
        const sshCommandPath = (await getAppConfig()).sshCommandPath;
        // Same large-file guard as opening a text file: an <img>
        // reference pointing at something huge shouldn't pull it over
        // the wire any more than clicking it in the tree should. Fall
        // back to a live stat when the path isn't in the current tree
        // snapshot (e.g. added on the remote side since the last
        // listing) - treating "not found" as size 0 would skip the
        // guard entirely for exactly the untracked files most likely to
        // be unexpectedly large.
        const node = flattenTree(tree).find((n) => n.path === relPath);
        const size = node ? node.size : await sshStatSize(sshProfile, sshCommandPath, relPath);
        if (size > LARGE_FILE_WARN_BYTES) return null;
        const base64 = await sshReadFileBase64(sshProfile, sshCommandPath, relPath);
        const uri = `data:${mimeTypeOf(relPath)};base64,${base64}`;
        sshImageCache.current.set(relPath, uri);
        return uri;
      } catch {
        return null;
      }
    },
    [workspaceKind, sshProfile, tree],
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

  // `kotoshelf .` / `kotoshelf notes.md` / `kotoshelf --ssh <profile-name>`
  // on the command line. Runs once on mount; a plain launch (no usable
  // arg) resolves to null and is a no-op.
  useEffect(() => {
    void getInitialTarget().then((target) => {
      if (!target) return;
      if (target.kind === "workspace") {
        void openWorkspaceAt(target.path);
      } else if (target.kind === "sshProfile") {
        void openSshWorkspace(target.profile);
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
      // An image tab has no text content to write - its content/
      // savedContent are always "". Without this guard, Ctrl+S while
      // viewing one would happily overwrite the actual image file with
      // an empty string.
      if (tab.kind === "image") return null;
      let targetPath = tab.path;
      // Whether this save lands at a path not already in the tree (a
      // brand-new file, or Save As to a different name) - the only case
      // that actually needs a tree refresh. Skipping it for an ordinary
      // save-in-place matters most for SSH workspaces: refreshing means
      // a full remote directory walk over the network on every Ctrl+S,
      // which is most of why saving felt sluggish compared to editing a
      // local file (a local refresh is a cheap fs read either way, but
      // there's no reason to pay even that when nothing structural
      // changed).
      const isNewPath = targetPath === null || forceDialog;

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
          // No round trip needed either way: a new path can only land
          // inside a directory the tree already has loaded (there's no
          // remote mkdir), and an existing path just needs its cached
          // size refreshed - both are a local splice/update, never a
          // re-walk of the remote tree over the network.
          setTree((prev) => insertTreeFile(prev, targetPath!, utf8ByteLength(tab.content)));
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
        if (workspace && isNewPath) void refreshTree(workspace);
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

  // ---- find/replace (current buffer) -----------------------------------

  const [finder, setFinder] = useState<FindReplaceState>(initialFindReplaceState);
  // CodeMirror's updateListener (wired below via onUpdate) fires for
  // every selection change unconditionally, including ones this file
  // itself dispatches (runFind's match-jump) - unlike Compose's
  // BasicTextField, whose onValueChange only fires for genuine user
  // interaction (see the parallel comment on EditorState.applyTabValue
  // in kotomemo, which needs no such marker for exactly that reason).
  // This ref records "the selection runFind just set", checked by
  // onUpdate so it can tell that apart from the user actually clicking
  // or dragging to select something - only the latter should update the
  // live Find/Replace scope.
  const lastAutoSelectionRef = useRef<{ from: number; to: number } | null>(null);

  const openFinder = useCallback((mode: "find" | "replace") => {
    if (activeTab?.kind !== "text") return;
    const view = editorViewRef.current;
    const sel = view?.state.selection.main;
    const scope = sel && !sel.empty ? { from: sel.from, to: sel.to } : null;
    setFinder((f) => {
      if (f.visible && f.mode === mode) return initialFindReplaceState;
      return { ...f, visible: true, mode, scope, lastReplaceCount: -1, wrapped: false, focusTick: f.focusTick + 1 };
    });
  }, [activeTab]);

  const closeFinder = useCallback(() => {
    setFinder(initialFindReplaceState);
    editorViewRef.current?.focus();
  }, []);

  const runFind = useCallback(() => {
    const view = editorViewRef.current;
    if (!view) return;
    const fullText = view.state.doc.toString();
    const from = finder.scope?.from ?? 0;
    const to = finder.scope?.to ?? fullText.length;
    const matches = findAllMatches(fullText.slice(from, to), finder.query, finder.regex, finder.caseSensitive).map(
      (m) => ({ from: m.from + from, to: m.to + from }),
    );
    if (matches.length === 0) {
      setFinder((f) => ({ ...f, lastMatchCount: 0, lastReplaceCount: -1, wrapped: false }));
      return;
    }
    const cursor = view.state.selection.main.head;
    const effectiveCursor = cursor < from || cursor > to ? from : cursor;
    const nextAfter = matches.find((m) => m.from >= effectiveCursor);
    const target = nextAfter ?? matches[0];
    lastAutoSelectionRef.current = { from: target.from, to: target.to };
    view.dispatch({ selection: { anchor: target.from, head: target.to }, scrollIntoView: true });
    setFinder((f) => ({ ...f, lastMatchCount: matches.length, lastReplaceCount: -1, wrapped: nextAfter == null }));
  }, [finder.scope, finder.query, finder.regex, finder.caseSensitive]);

  const runReplaceOne = useCallback(() => {
    const view = editorViewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    if (sel.empty) {
      runFind();
      return;
    }
    const fullText = view.state.doc.toString();
    const selectedText = fullText.slice(sel.from, sel.to);
    const matchesInSelection = findAllMatches(selectedText, finder.query, finder.regex, finder.caseSensitive);
    const isFullMatch =
      matchesInSelection.length === 1 &&
      matchesInSelection[0].from === 0 &&
      matchesInSelection[0].to === selectedText.length;
    if (!isFullMatch) {
      runFind();
      return;
    }
    const { text: replacementText } = replaceAllText(
      selectedText,
      finder.query,
      finder.replacement,
      finder.regex,
      finder.caseSensitive,
    );
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert: replacementText },
      selection: { anchor: sel.from + replacementText.length },
    });
    setFinder((f) => ({ ...f, lastReplaceCount: 1 }));
    runFind();
  }, [finder.query, finder.replacement, finder.regex, finder.caseSensitive, runFind]);

  const runReplaceAll = useCallback(() => {
    const view = editorViewRef.current;
    if (!view) return;
    const fullText = view.state.doc.toString();
    const scope = finder.scope;
    const from = scope?.from ?? 0;
    const to = scope?.to ?? fullText.length;
    const { text: replaced, count } = replaceAllText(
      fullText.slice(from, to),
      finder.query,
      finder.replacement,
      finder.regex,
      finder.caseSensitive,
    );
    if (count === 0) {
      setFinder((f) => ({ ...f, lastReplaceCount: 0 }));
      return;
    }
    view.dispatch({
      changes: { from, to, insert: replaced },
      selection: { anchor: from, head: from + replaced.length },
    });
    setFinder((f) => ({
      ...f,
      lastReplaceCount: count,
      scope: scope ? { from, to: from + replaced.length } : null,
    }));
  }, [finder.scope, finder.query, finder.replacement, finder.regex, finder.caseSensitive]);

  /** Keeps the Find/Replace scope following the live selection while the
   * bar is open - selecting something new re-scopes to it, deselecting
   * clears it back to whole-document. Only reacts to a pure selection
   * change (no doc edit alongside it, matching kotomemo's applyTabValue
   * guard) and ignores the one selection change this file causes itself
   * (runFind's match-jump, recognized via lastAutoSelectionRef) so
   * clicking "Find Next" doesn't collapse the scope down to whichever
   * match it just landed on. */
  const handleEditorUpdate = useCallback(
    (update: ViewUpdate) => {
      if (!finder.visible || update.docChanged || !update.selectionSet) return;
      const sel = update.state.selection.main;
      const auto = lastAutoSelectionRef.current;
      if (auto && auto.from === sel.from && auto.to === sel.to) {
        lastAutoSelectionRef.current = null;
        return;
      }
      setFinder((f) => ({ ...f, scope: sel.empty ? null : { from: sel.from, to: sel.to } }));
    },
    [finder.visible],
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
        const base64 = await fileToBase64(file);
        if (workspaceKind === "ssh" && sshProfile) {
          const sshCommandPath = (await getAppConfig()).sshCommandPath;
          await sshWriteBase64File(sshProfile, sshCommandPath, joinPath(dir, name), base64);
        } else {
          await writeBase64File(joinPath(dir, name), base64);
        }
        insertAtCursor(`![](${ATTACHMENTS_DIR}/${name})`);
        setStatus(`Attached ${name}`);
        // Full refresh here (not a local splice): the attachments/
        // folder may not exist in the current tree snapshot yet if this
        // is the first paste for this file, so there's no existing
        // parent node to splice into.
        if (workspace) void refreshTree(workspace);
      } catch (e) {
        setStatus(`${e}`);
      }
    },
    [insertAtCursor, workspace, workspaceKind, sshProfile, refreshTree],
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
        const name = `${timestampImageStem()}-${sanitizeAttachmentName(basename(p))}`;
        // `p` is a local absolute path either way; in a remote workspace
        // the destination is across the wire, so it has to be uploaded
        // rather than copied with the local-filesystem copyInto.
        const put =
          workspaceKind === "ssh" && sshProfile
            ? getAppConfig().then((c) =>
                sshUploadFile(sshProfile, c.sshCommandPath, p, joinPath(destDir, name)),
              )
            : copyInto(p, destDir, name).then(() => undefined);
        void put
          .then(() => {
            insertAtCursor(`![](${ATTACHMENTS_DIR}/${name})`);
            setStatus(`Attached ${name}`);
            if (workspace) void refreshTree(workspace);
          })
          .catch((e) => setStatus(`${e}`));
      } else if (workspaceKind === "ssh") {
        // A dropped path is local; opening it as a tab of a remote
        // workspace would make every later save target the wrong host.
        setStatus("Dropped files can't be opened while a remote workspace is open.");
      } else {
        void openFile(p);
      }
    }
  };

  useEffect(() => {
    // StrictMode (dev only) runs this effect's setup, then its cleanup,
    // then setup again, before the async onDragDropEvent registration
    // below has resolved. If cleanup just discarded a not-yet-arrived
    // unlisten function, the first listener would leak - never removed,
    // left running alongside the second setup's listener - so every
    // drop fired dropRef.current twice (the actual reported bug: one
    // dropped file inserting its ![]() reference twice). `cancelled`
    // makes the late-arriving listener unregister itself immediately if
    // cleanup already ran by the time the promise resolves.
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") dropRef.current(event.payload.paths);
      })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
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
      const isSsh = workspaceKind === "ssh" && !!sshProfile;
      // SSH tab/tree paths are workspace-relative; `workspace` itself
      // holds the *absolute* remote path (for display), so the no-tab
      // fallback here must be "" (relative root), not `workspace`.
      const dir = tab?.path ? dirname(tab.path) : isSsh ? "" : workspace;
      const newPath = joinPath(dir, fileName);
      void (async () => {
        try {
          if (isSsh) {
            const cmdPath = (await getAppConfig()).sshCommandPath;
            await sshWriteFile(sshProfile!, cmdPath, newPath, "");
            setTree((prev) => insertTreeFile(prev, newPath, 0));
          } else {
            await writeFile(newPath, "");
            await refreshTree(workspace);
          }
          await openFile(newPath);
          setStatus(`Created ${fileName}`);
        } catch (e) {
          setStatus(`${e}`);
        }
      })();
    },
    [workspace, tree, openFile, activeIndex, tabs, refreshTree, workspaceKind, sshProfile],
  );

  // Keep the editor-extension callbacks fresh (see interactionsRef).
  interactionsRef.current = { wiki: resolveWikiLink, imagePaste: handleImagePaste };

  // ---- tree operations (context menu) ---------------------------------

  /** Directory a "new file/folder here" operation should target.
   *
   * An SSH workspace's tree paths are relative to the remote folder, so
   * its root is "" - NOT `workspace`, which holds the absolute remote
   * path for display only. Returning the absolute path there would build
   * targets like "/Volumes/.../notes.md" and graft a whole "/Volumes/..."
   * branch onto a tree whose other paths are relative. Returns null only
   * when there's no workspace at all; "" is a valid target. */
  const menuTargetDir = useCallback(
    (node: TreeNode | null): string | null => {
      if (!workspace) return null;
      if (!node) return workspaceKind === "ssh" && sshProfile ? "" : workspace;
      return node.isDir ? node.path : dirname(node.path);
    },
    [workspace, workspaceKind, sshProfile],
  );

  const treeMenuActions = useCallback(
    (node: TreeNode | null): MenuAction[] => {
      const dir = menuTargetDir(node);
      // "" is the SSH workspace root - a valid target, so check for null
      // explicitly rather than falsiness.
      if (dir === null || !workspace) return [];
      const isSsh = workspaceKind === "ssh" && !!sshProfile;
      // basename("") is "", which would render as "New file in /".
      const dirLabel = basename(dir) || basename(workspace);
      const actions: MenuAction[] = [
        {
          label: "New File…",
          onClick: () =>
            setNamePrompt({
              title: `New file in ${dirLabel}/`,
              onSubmit: (name) => {
                const p = joinPath(dir, name);
                if (isSsh) {
                  void (async () => {
                    try {
                      const cmdPath = (await getAppConfig()).sshCommandPath;
                      await sshWriteFile(sshProfile!, cmdPath, p, "");
                      // No round trip needed: we know exactly what was
                      // created, so splice it in rather than re-walking
                      // the remote tree.
                      setTree((prev) => insertTreeFile(prev, p, 0));
                      await openFile(p);
                    } catch (e) {
                      setStatus(`${e}`);
                    }
                  })();
                  return;
                }
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
              title: `New folder in ${dirLabel}/`,
              onSubmit: (name) => {
                const p = joinPath(dir, name);
                if (isSsh) {
                  void (async () => {
                    try {
                      const cmdPath = (await getAppConfig()).sshCommandPath;
                      await sshCreateDir(sshProfile!, cmdPath, p);
                      setTree((prev) => insertTreeDir(prev, p));
                    } catch (e) {
                      setStatus(`${e}`);
                    }
                  })();
                  return;
                }
                void createDir(p)
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
                  const applyRename = () => {
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
                  };
                  if (isSsh) {
                    void (async () => {
                      try {
                        const cmdPath = (await getAppConfig()).sshCommandPath;
                        await sshRenamePath(sshProfile!, cmdPath, node.path, to);
                        applyRename();
                        // A renamed folder relocates every descendant's
                        // path, which a local splice doesn't attempt -
                        // simpler and safer to just re-fetch here, since
                        // renames are rare compared to plain saves.
                        await refreshTree(workspace);
                      } catch (e) {
                        setStatus(`${e}`);
                      }
                    })();
                    return;
                  }
                  void renamePath(node.path, to)
                    .then(() => {
                      applyRename();
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
              if (isSsh) {
                void (async () => {
                  try {
                    const cmdPath = (await getAppConfig()).sshCommandPath;
                    await sshTrashPath(sshProfile!, cmdPath, node.path);
                    setStatus(`Moved ${node.name} to .kotoshelf/.trash`);
                    await refreshTree(workspace);
                  } catch (e) {
                    setStatus(`${e}`);
                  }
                })();
                return;
              }
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
    [menuTargetDir, workspace, workspaceKind, sshProfile, refreshTree, openFile],
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
    openFind: () => openFinder("find"),
    openReplace: () => openFinder("replace"),
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
      } else if (key === "f") {
        e.preventDefault();
        dedup("openFind", c.openFind);
      } else if (key === "h") {
        e.preventDefault();
        dedup("openReplace", c.openReplace);
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
      <aside
        className="shrink-0 border-r border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 flex flex-col"
        style={{ width: leftPaneWidth }}
      >
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

      {/* Drag to resize the left sidebar. */}
      <div
        className="w-1 shrink-0 cursor-col-resize hover:bg-blue-400/50 active:bg-blue-500/50"
        onMouseDown={startLeftPaneResize}
      />

      {/* Center: tab bar + editor */}
      <main className="flex-1 min-w-0 flex flex-col">
        <TabBar
          tabs={tabs}
          activeIndex={activeIndex}
          onSelect={setActiveIndex}
          onClose={closeTab}
        />
        {finder.visible && activeTab?.kind === "text" && (
          <FindReplaceBar
            finder={finder}
            onQueryChange={(query) => setFinder((f) => ({ ...f, query }))}
            onReplacementChange={(replacement) => setFinder((f) => ({ ...f, replacement }))}
            onRegexChange={(regex) => setFinder((f) => ({ ...f, regex }))}
            onCaseSensitiveChange={(caseSensitive) => setFinder((f) => ({ ...f, caseSensitive }))}
            onFindNext={runFind}
            onReplaceOne={runReplaceOne}
            onReplaceAll={runReplaceAll}
            onClose={closeFinder}
          />
        )}
        <div className="flex-1 min-h-0 overflow-hidden">
          {activeTab?.kind === "image" ? (
            <div className="h-full flex items-center justify-center overflow-auto bg-slate-100 dark:bg-slate-950 p-4">
              <img
                src={activeTab.imageSrc}
                alt={activeTab.name}
                className="max-w-full max-h-full object-contain"
              />
            </div>
          ) : activeTab ? (
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
              onUpdate={handleEditorUpdate}
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
        {activeTab?.kind === "image" ? (
          <div className="text-sm text-slate-400 italic p-3">
            {activeTab.name} is an image - shown in the main pane.
          </div>
        ) : isMarkdownTab ? (
          <PreviewPane
            content={activeTab?.content ?? ""}
            fileDir={activeTab?.path ? dirname(activeTab.path) : null}
            resolveSshImage={workspaceKind === "ssh" && sshProfile ? resolveSshImage : undefined}
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
