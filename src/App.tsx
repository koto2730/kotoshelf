import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { crosshairCursor, rectangularSelection, type EditorView, type ViewUpdate } from "@codemirror/view";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { LanguageDescription } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
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
  formatBytes,
  getInitialTarget,
  insertTreeChildren,
  insertTreeDir,
  insertTreeFile,
  LARGE_FILE_WARN_BYTES,
  listAllPaths,
  pickWorkspaceFolder,
  readFile,
  readTreeShallow,
  removeTreeNode,
  renamePath,
  renameTreeNode,
  replaceInFiles,
  searchWorkspace,
  trashPath,
  utf8ByteLength,
  writeBase64File,
  writeFile,
  type FileSearchResult,
  type ReplaceResult,
  type TreeNode,
} from "./lib/fs";
import {
  ATTACHMENTS_DIR,
  base64ToObjectUrl,
  base64ToUtf8,
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
import { extractSessionId, renderTemplate } from "./lib/apiTemplateRenderer";
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
  sshAgentConnect,
  sshListAllPaths,
  sshReadFileGuarded,
  sshReadTreeShallow,
  sshWriteFile,
  sshWriteBase64File,
  sshUploadFile,
  sshCreateDir,
  sshRenamePath,
  sshTrashPath,
  sshSearchWorkspace,
  sshReplaceInFiles,
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
  /** Paths currently expanded in the tree pane. Lives here (not inside
   * FileTree) so expanding a folder whose children aren't loaded yet can
   * trigger a fetch - the tree is loaded lazily, one level at a time,
   * rather than the whole workspace walked up front on every connect. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Cache of relPath -> blob: object URL for SSH preview images (see
  // resolveSshImage below). A ref, not state - it's a cache, not
  // something that should itself trigger a re-render when filled in.
  const sshImageCache = useRef<Map<string, string>>(new Map());
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
  // Resizable + hideable right preview pane - same rationale as the left
  // sidebar (a fixed width cramps some content), plus a way to reclaim
  // the whole window width for editing when the rendered preview isn't
  // needed.
  const [previewVisible, setPreviewVisible] = useState(true);
  const [previewPaneWidth, setPreviewPaneWidth] = useState(384); // matches the old fixed w-96
  const previewPaneResizing = useRef(false);
  const startPreviewPaneResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    previewPaneResizing.current = true;
    const onMove = (ev: MouseEvent) => {
      if (!previewPaneResizing.current) return;
      // Measured from the right edge, since this pane is anchored there.
      setPreviewPaneWidth(Math.min(800, Math.max(240, window.innerWidth - ev.clientX)));
    };
    const onUp = () => {
      previewPaneResizing.current = false;
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

  // Non-markdown tabs get syntax highlighting by matching the file name
  // against @codemirror/language-data's ~200-language table - the same
  // `languages` list markdown's fenced code blocks already use via
  // `codeLanguages` below, just matched by the whole file's name instead
  // of a fence's language tag. Not meant to be authoritative (a
  // misdetected/unknown extension just falls back to plain text) - only
  // readable, so an exact-match-by-extension lookup is enough.
  // LanguageDescription.load() dynamically imports the matched
  // language's package and caches the result itself, so calling it again
  // for a language already loaded elsewhere in the app is free.
  const [fileLangExtension, setFileLangExtension] = useState<Extension | null>(null);
  useEffect(() => {
    if (isMarkdownTab || !activeTab?.name) {
      setFileLangExtension(null);
      return;
    }
    const desc = LanguageDescription.matchFilename(languages, activeTab.name);
    if (!desc) {
      setFileLangExtension(null);
      return;
    }
    let cancelled = false;
    void desc.load().then((support) => {
      if (!cancelled) setFileLangExtension(support);
    });
    return () => {
      cancelled = true;
    };
  }, [isMarkdownTab, activeTab?.name]);

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
    if (!isMarkdownTab) return fileLangExtension ? [...base, fileLangExtension] : base;
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
  }, [isMarkdownTab, resolvedTheme, fileLangExtension]);

  // ---- workspace ----------------------------------------------------

  // One level of `dir`'s children, dispatched to the local or SSH
  // shallow-listing command - the tree pane loads lazily, one folder at
  // a time, instead of walking the whole workspace (recursively `stat`ing
  // every file) on every connect/refresh.
  const loadDirShallow = useCallback(
    async (dir: string): Promise<TreeNode[]> => {
      if (workspaceKind === "ssh" && sshProfile) {
        const config = await getAppConfig();
        return sshReadTreeShallow(sshProfile, config.sshCommandPath, dir);
      }
      return readTreeShallow(dir);
    },
    [workspaceKind, sshProfile],
  );

  // The workspace root itself: SSH tree paths are relative ("" = root),
  // but local ones are absolute, so the root isn't just another
  // `loadDirShallow` call - it needs `workspace` substituted in for the
  // local branch.
  const loadRootShallow = useCallback(async (): Promise<TreeNode[]> => {
    if (workspaceKind === "ssh" && sshProfile) {
      const config = await getAppConfig();
      return sshReadTreeShallow(sshProfile, config.sshCommandPath, "");
    }
    return workspace ? readTreeShallow(workspace) : [];
  }, [workspaceKind, sshProfile, workspace]);

  // Expands/collapses a tree row. Expanding a folder whose children
  // haven't been fetched yet (`children` still null/undefined, the lazy
  // tree's default) fetches just that one folder - not the rest of the
  // workspace.
  const handleToggleDir = useCallback(
    async (node: TreeNode) => {
      const wasExpanded = expanded.has(node.path);
      setExpanded((prev) => {
        const next = new Set(prev);
        if (wasExpanded) next.delete(node.path);
        else next.add(node.path);
        return next;
      });
      if (wasExpanded || node.children) return;
      try {
        const children = await loadDirShallow(node.path);
        setTree((prev) => insertTreeChildren(prev, node.path, children));
      } catch (e) {
        setStatus(`${e}`);
      }
    },
    [expanded, loadDirShallow],
  );

  // Re-fetches the workspace root (one level), then re-fetches whatever
  // folders are currently expanded so an explicit Refresh updates what's
  // visible instead of collapsing it back to "not loaded" - without ever
  // paying for a full recursive re-walk of the whole workspace, which is
  // exactly what the lazy tree pane exists to avoid.
  const refreshTree = useCallback(async () => {
    if (!workspace) return;
    try {
      setTree(await loadRootShallow());
      for (const dirPath of expanded) {
        try {
          const children = await loadDirShallow(dirPath);
          setTree((prev) => insertTreeChildren(prev, dirPath, children));
        } catch {
          // Folder likely renamed/removed remotely since - drop it from
          // the expanded set instead of leaving a dead entry in it.
          setExpanded((prev) => {
            const next = new Set(prev);
            next.delete(dirPath);
            return next;
          });
        }
      }
    } catch (e) {
      setStatus(`Failed to read workspace: ${e}`);
    }
  }, [workspace, expanded, loadDirShallow, loadRootShallow]);

  const openWorkspaceAt = useCallback(async (path: string) => {
    setWorkspaceKind("local");
    setSshProfile(null);
    setWorkspace(path);
    setExpanded(new Set());
    for (const uri of sshImageCache.current.values()) URL.revokeObjectURL(uri);
    sshImageCache.current.clear();
    try {
      setTree(await readTreeShallow(path));
      setStatus(`Workspace: ${path}`);
    } catch (e) {
      setStatus(`Failed to read workspace: ${e}`);
    }
  }, []);

  const openFolder = useCallback(async () => {
    const picked = await pickWorkspaceFolder();
    if (!picked) return;
    await openWorkspaceAt(picked);
  }, [openWorkspaceAt]);

  const openSshWorkspace = useCallback(async (profile: SshProfile) => {
    setWorkspaceKind("ssh");
    setSshProfile(profile);
    setWorkspace(profile.remotePath);
    setExpanded(new Set());
    for (const uri of sshImageCache.current.values()) URL.revokeObjectURL(uri);
    sshImageCache.current.clear();
    try {
      const config = await getAppConfig();
      try {
        await sshAgentConnect(profile, config.sshCommandPath);
      } catch {
        // Best-effort perf optimization - every SSH command below still
        // works without it (falls back to its own per-operation `ssh`
        // shell-out), so a deploy/connect failure here isn't worth
        // surfacing as a workspace-open failure.
      }
      setTree(await sshReadTreeShallow(profile, config.sshCommandPath, ""));
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
      // Appends inside the setTabs updater itself, re-checking for an
      // existing tab there rather than trusting the `existing` check
      // above - that check only sees the `tabs` snapshot from when this
      // openFile() call started, so two concurrent openFile() calls for
      // the same brand-new path (e.g. "New File..." immediately
      // followed by a click on the file that just appeared in the tree,
      // or React StrictMode's dev-only double-invoke of this same async
      // callback) could otherwise both pass that check before either
      // had actually added a tab, producing two tabs for one path. The
      // updater form is applied against React's true latest state, so
      // the second call always sees the first call's tab once it lands.
      const appendTabIfMissing = (makeTab: () => Tab) => {
        setTabs((prev) => {
          const i = prev.findIndex((t) => t.path === path);
          if (i >= 0) {
            setActiveIndex(i);
            return prev;
          }
          const next = [...prev, makeTab()];
          setActiveIndex(next.length - 1);
          return next;
        });
      };
      try {
        // An image file used to get read as text - its raw bytes
        // reinterpreted as UTF-8 into a CodeMirror buffer, i.e. visible
        // mojibake. Route it to a read-only image tab instead.
        if (isImagePath(path)) {
          let imageSrc: string;
          if (workspaceKind === "ssh" && sshProfile) {
            const sshCommandPath = (await getAppConfig()).sshCommandPath;
            // One ssh round trip stats-then-reads (or refuses) - the tree
            // lazily loads folders now, so a path opened via search/wiki
            // links routinely isn't in the loaded tree at all, unlike
            // when this only had to cover a rare cache miss.
            const outcome = await sshReadFileGuarded(
              sshProfile,
              sshCommandPath,
              path,
              LARGE_FILE_WARN_BYTES,
            );
            if (outcome.tooLarge) {
              setStatus(
                `${basename(path)} is ${formatBytes(outcome.size)} - too large to open over SSH.`,
              );
              return;
            }
            imageSrc = base64ToObjectUrl(outcome.contentBase64!, mimeTypeOf(path));
          } else {
            imageSrc = convertFileSrc(path);
          }
          appendTabIfMissing(() => makeImageTab(path, imageSrc));
          return;
        }

        let content: string;
        if (workspaceKind === "ssh" && sshProfile) {
          const sshCommandPath = (await getAppConfig()).sshCommandPath;
          const outcome = await sshReadFileGuarded(
            sshProfile,
            sshCommandPath,
            path,
            LARGE_FILE_WARN_BYTES,
          );
          // A hard block, not a confirm-to-proceed dialog: a misclick
          // among a lot of listed files needing an app restart is worse
          // than the file simply not opening. The ^ marker in the tree
          // is the warning; this is what makes it actually stick.
          if (outcome.tooLarge) {
            setStatus(
              `${basename(path)} is ${formatBytes(outcome.size)} - too large to open over SSH.`,
            );
            return;
          }
          content = base64ToUtf8(outcome.contentBase64!);
        } else {
          content = await readFile(path);
        }
        appendTabIfMissing(() => makeFileTab(path, content));
      } catch (e) {
        setStatus(`${e}`);
      }
    },
    [tabs, workspaceKind, sshProfile],
  );

  // Preview images have no local file for <img src="file://..."> to load
  // in an SSH workspace, so they're fetched as bytes and shown via a
  // blob: object URL instead (see components/PreviewPane.tsx). Cached by
  // path so re-rendering the preview (every keystroke elsewhere in the
  // note) doesn't re-fetch an image that hasn't changed; a ref rather
  // than state since it's a cache, not something that should itself
  // trigger a re-render when it's filled in after the fact.
  const resolveSshImage = useCallback(
    async (relPath: string): Promise<string | null> => {
      if (!(workspaceKind === "ssh" && sshProfile)) return null;
      const cached = sshImageCache.current.get(relPath);
      if (cached) return cached;
      try {
        const sshCommandPath = (await getAppConfig()).sshCommandPath;
        // Same large-file guard as opening a text file, folded into the
        // same single round trip - the lazy tree pane means the note's
        // own folder (let alone an image sitting in it) routinely isn't
        // loaded, so there's no cached size to check here anymore.
        const outcome = await sshReadFileGuarded(
          sshProfile,
          sshCommandPath,
          relPath,
          LARGE_FILE_WARN_BYTES,
        );
        if (outcome.tooLarge) return null;
        const uri = base64ToObjectUrl(outcome.contentBase64!, mimeTypeOf(relPath));
        sshImageCache.current.set(relPath, uri);
        return uri;
      } catch {
        return null;
      }
    },
    [workspaceKind, sshProfile],
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
  // Parameterized by index (rather than always reading activeIndex) so
  // saveAll can drive it across every dirty tab in turn, not just the
  // active one - saveActive below is just this called with the active
  // tab's index.
  const saveTabAt = useCallback(
    async (index: number, forceDialog = false): Promise<string | null> => {
      const tab = tabs[index];
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
              i === index
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
            i === index
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
        if (workspace && isNewPath) void refreshTree();
        return targetPath;
      } catch (e) {
        setStatus(`${e}`);
        return null;
      }
    },
    [tabs, workspace, workspaceKind, sshProfile, refreshTree],
  );

  const saveActive = useCallback(
    (forceDialog = false): Promise<string | null> => saveTabAt(activeIndex, forceDialog),
    [saveTabAt, activeIndex],
  );

  const saveAll = useCallback(async () => {
    const dirtyIndexes = tabs
      .map((_, i) => i)
      .filter((i) => tabs[i].kind !== "image" && isDirty(tabs[i]));
    if (dirtyIndexes.length === 0) {
      setStatus("Nothing to save");
      return;
    }
    let saved = 0;
    for (const i of dirtyIndexes) {
      if ((await saveTabAt(i)) !== null) saved++;
    }
    setStatus(`Saved ${saved} of ${dirtyIndexes.length} file(s)`);
  }, [tabs, saveTabAt]);

  const closeAllTabs = useCallback(() => {
    const dirtyCount = tabs.filter((t) => isDirty(t)).length;
    if (dirtyCount > 0) {
      const ok = window.confirm(
        `${dirtyCount} file(s) have unsaved changes. Close all tabs anyway?`,
      );
      if (!ok) return;
    }
    setTabs([]);
    setActiveIndex(-1);
  }, [tabs]);

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
      // Image tabs opened over SSH hold a blob: object URL (see
      // base64ToObjectUrl) rather than a data: URI - that binary data
      // lives outside JS-managed memory until explicitly released.
      if (tab.imageSrc?.startsWith("blob:")) URL.revokeObjectURL(tab.imageSrc);
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
        // Not a local splice: the attachments/ folder may not exist in
        // the current tree snapshot yet if this is the first paste for
        // this file, so there's no existing parent node to splice into.
        // refreshTree only re-fetches the root plus whatever's already
        // expanded, so this only surfaces the new folder in the tree
        // pane if its parent happens to be expanded - the attachment
        // itself is written either way, this is purely a tree-display
        // nicety.
        if (workspace) void refreshTree();
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
            if (workspace) void refreshTree();
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
    async (target: string) => {
      if (!workspace) {
        setStatus("Open a workspace to resolve wiki links.");
        return;
      }
      const t = target.toLowerCase();
      // Matches by name across the *whole* workspace via a dedicated
      // name-only listing (no `stat`, no size) rather than the tree
      // pane's state - the tree loads lazily now, one folder at a time,
      // so a note several unexpanded folders deep wouldn't be found in
      // it and would look like it doesn't exist yet.
      let allPaths: string[];
      try {
        allPaths =
          workspaceKind === "ssh" && sshProfile
            ? await sshListAllPaths(sshProfile, (await getAppConfig()).sshCommandPath)
            : await listAllPaths(workspace);
      } catch (e) {
        setStatus(`${e}`);
        return;
      }
      const matches = allPaths.filter((p) => {
        const name = basename(p).toLowerCase();
        return name === `${t}.md` || name === t;
      });
      if (matches.length === 1) {
        void openFile(matches[0]);
        return;
      }
      if (matches.length > 1) {
        setWikiChoices(matches.map((p) => ({ label: basename(p), detail: p, value: p })));
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
      try {
        if (isSsh) {
          const cmdPath = (await getAppConfig()).sshCommandPath;
          await sshWriteFile(sshProfile!, cmdPath, newPath, "");
          setTree((prev) => insertTreeFile(prev, newPath, 0));
        } else {
          await writeFile(newPath, "");
          await refreshTree();
        }
        await openFile(newPath);
        setStatus(`Created ${fileName}`);
      } catch (e) {
        setStatus(`${e}`);
      }
    },
    [workspace, openFile, activeIndex, tabs, refreshTree, workspaceKind, sshProfile],
  );

  // Keep the editor-extension callbacks fresh (see interactionsRef).
  interactionsRef.current = { wiki: resolveWikiLink, imagePaste: handleImagePaste };

  // ---- workspace-wide search/replace -----------------------------------

  // Dispatched to Rust either way (search_workspace/ssh_search_workspace),
  // so a few thousand notes never round-trip full file contents through
  // IPC just to grep them - SearchPanel itself doesn't need to know which
  // kind of workspace it's searching.
  const handleSearch = useCallback(
    async (query: string, isRegex: boolean, caseSensitive: boolean): Promise<FileSearchResult[]> => {
      if (workspaceKind === "ssh" && sshProfile) {
        const cmdPath = (await getAppConfig()).sshCommandPath;
        return sshSearchWorkspace(sshProfile, cmdPath, query, isRegex, caseSensitive);
      }
      return searchWorkspace(workspace ?? "", query, isRegex, caseSensitive);
    },
    [workspaceKind, sshProfile, workspace],
  );

  const handleReplace = useCallback(
    async (
      paths: string[],
      query: string,
      replacement: string,
      isRegex: boolean,
      caseSensitive: boolean,
    ): Promise<ReplaceResult[]> => {
      if (workspaceKind === "ssh" && sshProfile) {
        const cmdPath = (await getAppConfig()).sshCommandPath;
        return sshReplaceInFiles(
          sshProfile,
          cmdPath,
          paths,
          query,
          replacement,
          isRegex,
          caseSensitive,
        );
      }
      return replaceInFiles(paths, query, replacement, isRegex, caseSensitive);
    },
    [workspaceKind, sshProfile],
  );

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
                  .then(() => refreshTree())
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
                  .then(() => refreshTree())
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
                        // renameTreeNode rewrites the node's own path and
                        // every already-loaded descendant's path prefix
                        // in memory - no re-fetch needed even for a
                        // folder, since anything not yet loaded is still
                        // unloaded either way and gets requested under
                        // the new path whenever it's expanded.
                        setTree((prev) => renameTreeNode(prev, node.path, to));
                        setExpanded((prev) => {
                          const next = new Set<string>();
                          for (const p of prev) {
                            if (p === node.path) next.add(to);
                            else if (p.startsWith(`${node.path}/`)) next.add(to + p.slice(node.path.length));
                            else next.add(p);
                          }
                          return next;
                        });
                      } catch (e) {
                        setStatus(`${e}`);
                      }
                    })();
                    return;
                  }
                  void renamePath(node.path, to)
                    .then(() => {
                      applyRename();
                      return refreshTree();
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
                    // We know exactly what was removed - splice it out
                    // rather than re-walking the remote tree.
                    setTree((prev) => removeTreeNode(prev, node.path));
                    setExpanded((prev) => {
                      const next = new Set(prev);
                      for (const p of prev) {
                        if (p === node.path || p.startsWith(`${node.path}/`)) next.delete(p);
                      }
                      return next;
                    });
                  } catch (e) {
                    setStatus(`${e}`);
                  }
                })();
                return;
              }
              void trashPath(node.path)
                .then(() => {
                  setStatus(`Moved ${node.name} to trash`);
                  return refreshTree();
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
        const filename = tab.name.replace(/\.[^.]+$/, "");
        // The session id travels with the selection itself (a
        // "SessionID: ..." line left there by a previous response - see
        // extractSessionId), not with the preset, so it's read fresh
        // from whatever text is selected right now.
        const sessionId = extractSessionId(selectionText);
        const renderedPrompt = preset.promptTemplate
          ? renderTemplate(preset.promptTemplate, {
              selection: "",
              filename,
              tokens: config.tokens,
              sessionId,
            })
          : "";
        const combinedSelection = renderedPrompt
          ? `${renderedPrompt}\n\n${selectionText}`
          : selectionText;
        const ctx = {
          selection: combinedSelection,
          filename,
          tokens: config.tokens,
          sessionId,
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
          // The error body (usually the API's own explanation - a
          // missing header, bad auth, malformed JSON, etc.) was
          // previously discarded here, leaving just the status code to
          // debug from. Surface it in a tab so it's actually readable.
          const errTab = makeUntitledTab();
          errTab.content = response.body;
          setTabs((prev) => [...prev, errTab]);
          setActiveIndex(tabs.length);
          setStatus(`Send failed: HTTP ${response.status} (see new tab for response body)`);
          return;
        }
        const extracted = preset.responseJsonPath
          ? extractJsonPath(response.body, preset.responseJsonPath) ?? response.body
          : response.body;

        // Session bookkeeping lines, read from the *raw* response body
        // (independent of responseJsonPath, since the session id/updated
        // fields usually live outside whatever the preset extracts as
        // the "real" content) and appended after it so a later send can
        // pick them back up via extractSessionId/{{sessionId}}.
        const sessionLines: string[] = [];
        if (preset.sessionIdPath) {
          const v = extractJsonPath(response.body, preset.sessionIdPath);
          if (v) sessionLines.push(`SessionID: ${v}`);
        }
        if (preset.sessionUpdatedPath) {
          const v = extractJsonPath(response.body, preset.sessionUpdatedPath);
          if (v) sessionLines.push(`session_updated: ${v}`);
        }
        const extractedWithSession = sessionLines.length
          ? `${extracted}${extracted.endsWith("\n") ? "" : "\n"}${sessionLines.join("\n")}\n`
          : extracted;

        if (preset.responseTarget === "newTab") {
          const newTab = makeUntitledTab();
          newTab.content = extractedWithSession;
          setTabs((prev) => [...prev, newTab]);
          setActiveIndex(tabs.length);
        } else if (preset.responseTarget === "afterSelection") {
          const end = sel.to;
          const needsNewlineBefore =
            end > 0 && view.state.sliceDoc(end - 1, end) !== "\n";
          const needsNewlineAfter = !extractedWithSession.endsWith("\n");
          const payload =
            (needsNewlineBefore ? "\n" : "") +
            extractedWithSession +
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
    saveAll: () => void saveAll(),
    closeActiveTab: () => closeTab(activeIndex),
    closeAllTabs: () => closeAllTabs(),
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
    togglePreview: () => setPreviewVisible((v) => !v),
    openSendPalette: () => {
      // CodeMirror's contentEditable holds DOM focus tightly; opening the
      // palette on top of it without an explicit blur can leave the
      // editor as document.activeElement even after the palette mounts
      // with autoFocus, so arrow keys/Enter keep going to the buffer
      // instead of the picker.
      editorViewRef.current?.contentDOM.blur();
      setSendPaletteOpen(true);
    },
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
  //
  // Also handles VS Code-style two-stage chords (Ctrl+K, then a second
  // key within chordTimeoutMs) for tab operations - Save All (Ctrl+K S)
  // and Close All Tabs (Ctrl+K Ctrl+W). A native menu accelerator can
  // only express one simultaneous modifier+key combo, not a sequence, so
  // these exist only here, not as a real OS-level shortcut (the menu
  // items just document them in their label text).
  const chordTimeoutRef = useRef<number | null>(null);
  useEffect(() => {
    const clearChord = () => {
      if (chordTimeoutRef.current !== null) {
        window.clearTimeout(chordTimeoutRef.current);
        chordTimeoutRef.current = null;
      }
    };
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const c = commandsRef.current;

      if (chordTimeoutRef.current !== null) {
        const key = e.key.toLowerCase();
        clearChord();
        if (key === "s" && !mod) {
          e.preventDefault();
          dedup("saveAll", c.saveAll);
        } else if (key === "w" && mod) {
          e.preventDefault();
          dedup("closeAllTabs", c.closeAllTabs);
        }
        // Any other second key just cancels the chord (and is otherwise
        // left alone - not swallowed - since it wasn't meant for us).
        return;
      }

      if (mod && e.key.toLowerCase() === "k" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        chordTimeoutRef.current = window.setTimeout(clearChord, 1500);
        return;
      }

      if (!mod) return;
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
      } else if (key === "v" && e.shiftKey) {
        e.preventDefault();
        dedup("togglePreview", c.togglePreview);
      } else if (e.key === ";") {
        e.preventDefault();
        dedup("openSendPalette", c.openSendPalette);
      }
    };
    window.addEventListener("keydown", handler, { capture: true });
    return () => {
      window.removeEventListener("keydown", handler, { capture: true });
      clearChord();
    };
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
            onSearch={handleSearch}
            onReplace={handleReplace}
            excludeConfigSupported={!(workspaceKind === "ssh" && sshProfile)}
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
                  onClick={() => void refreshTree()}
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
                  expanded={expanded}
                  onToggle={(node) => void handleToggleDir(node)}
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

      {previewVisible && (
        <>
          {/* Drag to resize the right preview pane. */}
          <div
            className="w-1 shrink-0 cursor-col-resize hover:bg-blue-400/50 active:bg-blue-500/50"
            onMouseDown={startPreviewPaneResize}
          />

          {/* Right: rendered Markdown preview. Relative images + wiki-link
              resolution still pending (Phase 3). */}
          <aside
            className="shrink-0 border-l border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 overflow-y-auto"
            style={{ width: previewPaneWidth }}
          >
            <div className="flex items-center justify-between px-3 pt-3">
              <span className="text-xs uppercase tracking-wide text-slate-500">
                Preview
              </span>
              <button
                type="button"
                className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-300"
                title="Hide preview (Ctrl+Shift+V)"
                onClick={() => setPreviewVisible(false)}
              >
                ✕
              </button>
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
        </>
      )}

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
