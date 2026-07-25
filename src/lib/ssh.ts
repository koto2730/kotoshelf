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

export function sshWriteFile(
  profile: SshProfile,
  sshCommandPath: string,
  relPath: string,
  content: string,
): Promise<void> {
  return invoke("ssh_write_file", { profile, sshCommandPath, relPath, content });
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
