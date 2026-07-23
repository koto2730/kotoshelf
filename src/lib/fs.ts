import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

/** Mirror of the Rust TreeNode struct (serde camelCase). */
export interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  children?: TreeNode[] | null;
}

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
