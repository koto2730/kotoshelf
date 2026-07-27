import { invoke } from "@tauri-apps/api/core";
import type { TreeNode } from "./fs";

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

/** Round-trips `cd <remotePath> && pwd` - surfaces an auth/host/path
 * failure immediately when the user clicks "Connect" instead of only on
 * the first file operation. Resolves to the resolved absolute path. */
export function sshTestConnection(profile: SshProfile, sshCommandPath: string): Promise<string> {
  return invoke<string>("ssh_test_connection", { profile, sshCommandPath });
}

/** Opens a new terminal window already `cd`'d into the remote workspace
 * folder over SSH (Windows Terminal / Terminal.app / a common Linux
 * emulator, depending on platform). */
export function sshOpenTerminal(profile: SshProfile, sshCommandPath: string): Promise<void> {
  return invoke("ssh_open_terminal", { profile, sshCommandPath });
}
