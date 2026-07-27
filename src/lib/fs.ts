import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** Mirror of the Rust TreeNode struct (serde camelCase). `size` is 0 for
 * directories - carried alongside the listing (rather than fetched
 * separately per file) so a "large file" check doesn't need its own
 * round trip. */
export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[] | null;
  size: number;
}

/** Above this, opening a file prompts for confirmation first - kotoshelf
 * is a text editor, and a multi-GB video or archive pulled whole into an
 * in-memory buffer is slow at best (worse over SSH, where it can make
 * the whole app appear to hang). 20 MB comfortably covers real text/log
 * files while still catching binary/media files opened by accident. */
export const LARGE_FILE_WARN_BYTES = 20 * 1024 * 1024;

/** Native folder picker. Resolves to null when the user cancels. */
export async function pickWorkspaceFolder(): Promise<string | null> {
  const picked = await open({ directory: true, multiple: false, title: "Open Workspace Folder" });
  return typeof picked === "string" ? picked : null;
}

export function readTree(root: string): Promise<TreeNode[]> {
  return invoke<TreeNode[]>("read_tree", { root });
}

export function readFile(path: string): Promise<string> {
  return invoke<string>("read_file", { path });
}

export function writeFile(path: string, content: string): Promise<void> {
  return invoke("write_file", { path, content });
}

/** Write binary data (base64-encoded) - used for pasted clipboard images. */
export function writeBase64File(path: string, contentsBase64: string): Promise<void> {
  return invoke("write_base64_file", { path, contentsBase64 });
}

/** Copy an existing file into destDir/destName; returns the destination path. */
export function copyInto(src: string, destDir: string, destName: string): Promise<string> {
  return invoke<string>("copy_into", { src, destDir, destName });
}

export function createDir(path: string): Promise<void> {
  return invoke("create_dir", { path });
}

export function renamePath(from: string, to: string): Promise<void> {
  return invoke("rename_path", { from, to });
}

/** Moves to the OS trash / recycle bin (never a permanent delete). */
export function trashPath(path: string): Promise<void> {
  return invoke("trash_path", { path });
}

export interface SearchMatch {
  line: number; // 1-based
  col: number; // 0-based char offset into the line
  len: number;
  preview: string;
}

export interface FileSearchResult {
  path: string;
  matches: SearchMatch[];
}

export function searchWorkspace(
  root: string,
  query: string,
  isRegex: boolean,
  caseSensitive: boolean,
): Promise<FileSearchResult[]> {
  return invoke<FileSearchResult[]>("search_workspace", {
    root,
    query,
    isRegex,
    caseSensitive,
  });
}

export interface ReplaceResult {
  path: string;
  count: number;
}

export interface SearchConfig {
  exclude: string[];
}

export function getSearchConfig(root: string): Promise<SearchConfig> {
  return invoke<SearchConfig>("get_search_config", { root });
}

export function setSearchConfig(root: string, config: SearchConfig): Promise<void> {
  return invoke("set_search_config", { root, config });
}

export function replaceInFiles(
  paths: string[],
  query: string,
  replacement: string,
  isRegex: boolean,
  caseSensitive: boolean,
): Promise<ReplaceResult[]> {
  return invoke<ReplaceResult[]>("replace_in_files", {
    paths,
    query,
    replacement,
    isRegex,
    caseSensitive,
  });
}

export type InitialTarget =
  | { kind: "workspace"; path: string }
  | { kind: "file"; path: string; workspace: string };

/** `kotoshelf <path>` / `kotoshelf .` from the command line, resolved once
 * at Rust startup. Called on mount; returns null for a plain launch with
 * no usable argument. */
export function getInitialTarget(): Promise<InitialTarget | null> {
  return invoke<InitialTarget | null>("get_initial_target");
}

/** Depth-first flatten of the workspace tree. */
export function flattenTree(nodes: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      out.push(n);
      if (n.children) walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** Dirs first, then alphabetical (case-insensitive) - mirrors the Rust
 * backend's build_tree ordering so a locally-spliced node lands where a
 * full re-fetch would have put it. */
function sortTreeNodes(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  });
}

/**
 * Inserts (or updates, if it already exists - same code path covers "new
 * file" and "re-saved an existing file with a fresh size") a single file
 * node at `relPath` into an already-loaded tree, without any round trip
 * to re-fetch it. Only meaningful for a path whose parent directory is
 * already present in `nodes` - true for every file write kotoshelf can
 * perform (a brand-new file can only land inside a directory that was
 * already there to find - there's no "create this new nested folder as
 * part of the save" path). Recursing into subdirectories only ever walks
 * nodes already held in memory; it never needs to ask the server
 * anything.
 */
export function insertTreeFile(nodes: TreeNode[], relPath: string, size: number): TreeNode[] {
  const parts = relPath.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return nodes;
  const fileName = parts[parts.length - 1];

  const insertInto = (list: TreeNode[], segments: string[], prefix: string): TreeNode[] => {
    if (segments.length === 0) {
      const filePath = prefix ? `${prefix}/${fileName}` : fileName;
      const withoutOld = list.filter((n) => n.isDir || n.name !== fileName);
      return sortTreeNodes([
        ...withoutOld,
        { name: fileName, path: filePath, isDir: false, size },
      ]);
    }
    const [head, ...rest] = segments;
    return list.map((n) => {
      if (!n.isDir || n.name !== head) return n;
      const newPrefix = prefix ? `${prefix}/${head}` : head;
      return { ...n, children: insertInto(n.children ?? [], rest, newPrefix) };
    });
  };

  return insertInto(nodes, parts.slice(0, -1), "");
}

/** Same idea as insertTreeFile, for a brand-new empty directory (e.g.
 * "New Folder…" in a remote workspace, which has no round trip to
 * re-list the parent either). */
export function insertTreeDir(nodes: TreeNode[], relPath: string): TreeNode[] {
  const parts = relPath.split("/").filter((p) => p.length > 0);
  if (parts.length === 0) return nodes;
  const dirName = parts[parts.length - 1];

  const insertInto = (list: TreeNode[], segments: string[], prefix: string): TreeNode[] => {
    if (segments.length === 0) {
      const dirPath = prefix ? `${prefix}/${dirName}` : dirName;
      const withoutOld = list.filter((n) => !n.isDir || n.name !== dirName);
      return sortTreeNodes([
        ...withoutOld,
        { name: dirName, path: dirPath, isDir: true, size: 0, children: [] },
      ]);
    }
    const [head, ...rest] = segments;
    return list.map((n) => {
      if (!n.isDir || n.name !== head) return n;
      const newPrefix = prefix ? `${prefix}/${head}` : head;
      return { ...n, children: insertInto(n.children ?? [], rest, newPrefix) };
    });
  };

  return insertInto(nodes, parts.slice(0, -1), "");
}

/** Byte length of `text` when UTF-8 encoded (JS string .length counts
 * UTF-16 code units, which overcounts multi-byte characters) - what a
 * save actually writes to disk, computed locally so an SSH save doesn't
 * need a follow-up round trip just to learn its own new size. */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
