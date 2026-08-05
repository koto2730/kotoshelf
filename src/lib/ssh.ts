import { invoke } from "@tauri-apps/api/core";
import type { FileSearchResult, ReplaceResult, TreeNode } from "./fs";

/** Mirror of the Rust SshProfile struct (serde camelCase). A saved
 * remote-workspace target: `port`/`user`/`identityFile` are optional so a
 * bare profile can lean entirely on the user's `~/.ssh/config` (Host
 * alias, default user, IdentityFile). */
export interface SshProfile {
  name: string;
  host: string;
  port: number | null;
  user: string | null;
  identityFile: string | null;
  remotePath: string;
}

export function newSshProfile(name: string): SshProfile {
  return {
    name,
    host: "",
    port: null,
    user: null,
    identityFile: null,
    remotePath: "/",
  };
}

export function sshReadTree(profile: SshProfile, sshCommandPath: string): Promise<TreeNode[]> {
  return invoke<TreeNode[]>("ssh_read_tree", { profile, sshCommandPath });
}

/** One level of `relPath`'s immediate children ("" for the workspace
 * root) - the remote counterpart of `readTreeShallow`. Subdirectories
 * come back with `children: null` ("not loaded yet"). */
export function sshReadTreeShallow(
  profile: SshProfile,
  sshCommandPath: string,
  relPath: string,
): Promise<TreeNode[]> {
  return invoke<TreeNode[]>("ssh_read_tree_shallow", { profile, sshCommandPath, relPath });
}

/** Every file path in the workspace, `find`-only (no `stat`) - for
 * wiki-link resolution, independent of the lazy tree's load state. */
export function sshListAllPaths(profile: SshProfile, sshCommandPath: string): Promise<string[]> {
  return invoke<string[]>("ssh_list_all_paths", { profile, sshCommandPath });
}

export function sshReadFile(
  profile: SshProfile,
  sshCommandPath: string,
  relPath: string,
): Promise<string> {
  return invoke<string>("ssh_read_file", { profile, sshCommandPath, relPath });
}

/** Binary-safe read (base64-encoded) for preview images - sshReadFile
 * decodes as UTF-8 text, which would corrupt arbitrary image bytes.
 * Caller is expected to size-check first (e.g. via the tree's cached
 * size); this doesn't refuse a large file on its own. */
export function sshReadFileBase64(
  profile: SshProfile,
  sshCommandPath: string,
  relPath: string,
): Promise<string> {
  return invoke<string>("ssh_read_file_base64", { profile, sshCommandPath, relPath });
}

export function sshWriteFile(
  profile: SshProfile,
  sshCommandPath: string,
  relPath: string,
  content: string,
): Promise<void> {
  return invoke("ssh_write_file", { profile, sshCommandPath, relPath, content });
}

/** Write binary data (base64-encoded) - used for pasted clipboard images
 * and dropped-file attachments over SSH. Creates parent directories as
 * needed, mirroring the local writeBase64File. */
export function sshWriteBase64File(
  profile: SshProfile,
  sshCommandPath: string,
  relPath: string,
  contentsBase64: string,
): Promise<void> {
  return invoke("ssh_write_base64_file", { profile, sshCommandPath, relPath, contentsBase64 });
}

/** Uploads a file that already exists on the local disk (a drag & drop
 * from the OS file manager) into the remote workspace. */
export function sshUploadFile(
  profile: SshProfile,
  sshCommandPath: string,
  localPath: string,
  relPath: string,
): Promise<void> {
  return invoke("ssh_upload_file", { profile, sshCommandPath, localPath, relPath });
}

export function sshCreateDir(
  profile: SshProfile,
  sshCommandPath: string,
  relPath: string,
): Promise<void> {
  return invoke("ssh_create_dir", { profile, sshCommandPath, relPath });
}

export function sshRenamePath(
  profile: SshProfile,
  sshCommandPath: string,
  fromRel: string,
  toRel: string,
): Promise<void> {
  return invoke("ssh_rename_path", { profile, sshCommandPath, fromRel, toRel });
}

/** Moves into `.kotoshelf/.trash/` on the remote workspace (never a
 * permanent delete) - there's no OS trash/recycle bin to move into on an
 * arbitrary remote host. */
export function sshTrashPath(
  profile: SshProfile,
  sshCommandPath: string,
  relPath: string,
): Promise<void> {
  return invoke("ssh_trash_path", { profile, sshCommandPath, relPath });
}

/** Remote file size in bytes, via `stat` (metadata, not content - it
 * doesn't read the file) - checked before sshReadFile so the caller can
 * warn/refuse rather than pulling an arbitrarily large file (e.g. a
 * multi-GB video) over the wire into an in-memory text buffer. */
export function sshStatSize(
  profile: SshProfile,
  sshCommandPath: string,
  relPath: string,
): Promise<number> {
  return invoke<number>("ssh_stat_size", { profile, sshCommandPath, relPath });
}

export interface SshReadOutcome {
  tooLarge: boolean;
  size: number;
  contentBase64: string | null;
}

/** Stat-then-read in a single ssh round trip: over `maxBytes` this
 * resolves with `tooLarge: true` and no content (mirrors the old
 * sshStatSize-then-refuse flow); otherwise `contentBase64` carries the
 * file. Replaces the separate sshStatSize + sshReadFile/
 * sshReadFileBase64 calls for opening a file over SSH. */
export function sshReadFileGuarded(
  profile: SshProfile,
  sshCommandPath: string,
  relPath: string,
  maxBytes: number,
): Promise<SshReadOutcome> {
  return invoke<SshReadOutcome>("ssh_read_file_guarded", {
    profile,
    sshCommandPath,
    relPath,
    maxBytes,
  });
}

/** Workspace-wide search over SSH, run entirely server-side in one ssh
 * round trip (the remote script fetches every candidate file's content
 * in one pass) rather than one round trip per file. */
export function sshSearchWorkspace(
  profile: SshProfile,
  sshCommandPath: string,
  query: string,
  isRegex: boolean,
  caseSensitive: boolean,
): Promise<FileSearchResult[]> {
  return invoke<FileSearchResult[]>("ssh_search_workspace", {
    profile,
    sshCommandPath,
    query,
    isRegex,
    caseSensitive,
  });
}

/** Mirrors replaceInFiles, operating on a remote workspace. `paths` is
 * expected to be a prior search's (typically small) result set. */
export function sshReplaceInFiles(
  profile: SshProfile,
  sshCommandPath: string,
  paths: string[],
  query: string,
  replacement: string,
  isRegex: boolean,
  caseSensitive: boolean,
): Promise<ReplaceResult[]> {
  return invoke<ReplaceResult[]>("ssh_replace_in_files", {
    profile,
    sshCommandPath,
    paths,
    query,
    replacement,
    isRegex,
    caseSensitive,
  });
}

/** Round-trips `cd <remotePath> && pwd` - surfaces an auth/host/path
 * failure immediately when the user clicks "Connect" instead of only on
 * the first file operation. Resolves to the resolved absolute path. */
export function sshTestConnection(profile: SshProfile, sshCommandPath: string): Promise<string> {
  return invoke<string>("ssh_test_connection", { profile, sshCommandPath });
}

/** Deploys (if not already cached on the remote host) and connects to
 * the persistent SSH agent - see `agent-protocol`/`agent` and
 * `ssh_agent_connect` in lib.rs. Best-effort by design: callers should
 * swallow a rejection and keep going, since every SSH command still
 * works without it, just slower (each falls back to its own
 * per-operation `ssh` shell-out when no agent session is connected). */
export function sshAgentConnect(profile: SshProfile, sshCommandPath: string): Promise<void> {
  return invoke("ssh_agent_connect", { profile, sshCommandPath });
}

/** Opens a new terminal window already `cd`'d into the remote workspace
 * folder over SSH (Windows Terminal / Terminal.app / a common Linux
 * emulator, depending on platform). */
export function sshOpenTerminal(profile: SshProfile, sshCommandPath: string): Promise<void> {
  return invoke("ssh_open_terminal", { profile, sshCommandPath });
}
