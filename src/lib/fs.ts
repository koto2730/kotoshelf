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
