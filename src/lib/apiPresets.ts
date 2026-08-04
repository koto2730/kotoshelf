import { invoke } from "@tauri-apps/api/core";
import type { SshProfile } from "./ssh";

export type ResponseTarget = "newTab" | "afterSelection" | "statusOnly";

export interface ApiPreset {
  name: string;
  url: string;
  method: string;
  /** Array of [name, value] pairs, not a Record - preserves insertion
   * order and allows duplicate header names (rare but valid HTTP). */
  headers: [string, string][];
  bodyTemplate: string;
  /** Prepended (as {{selection}}, before the rest of the template
   * placeholders are resolved) before the actual editor selection when
   * building the request - lets a preset carry a fixed instruction/
   * system-prompt-like prefix without the user retyping it into the
   * buffer each time. Empty means no prefix. */
  promptTemplate: string;
  responseJsonPath: string | null;
  responseTarget: ResponseTarget;
  /** Dotted JSON paths into the raw response body (same engine as
   * responseJsonPath) for a stateful API's session id / last-updated
   * fields. Optional - most presets have no notion of a session. When
   * set and found in the response, App.tsx appends them as plain
   * "SessionID: .../session_updated: ..." lines after the inserted
   * response text. */
  sessionIdPath: string | null;
  sessionUpdatedPath: string | null;
}

export function newPreset(name: string): ApiPreset {
  return {
    name,
    url: "https://",
    method: "POST",
    headers: [],
    bodyTemplate: "",
    promptTemplate: "",
    responseJsonPath: null,
    responseTarget: "newTab",
    sessionIdPath: null,
    sessionUpdatedPath: null,
  };
}

export interface AppConfig {
  presets: ApiPreset[];
  tokens: Record<string, string>;
  sshProfiles: SshProfile[];
  /** Empty means "ssh" resolved from PATH. */
  sshCommandPath: string;
}

export function getAppConfig(): Promise<AppConfig> {
  return invoke<AppConfig>("get_app_config");
}

export function setAppConfig(config: AppConfig): Promise<void> {
  return invoke("set_app_config", { config });
}

export interface SendRequestInput {
  url: string;
  method: string;
  headers: [string, string][];
  body: string | null;
}

export interface SendRequestOutput {
  status: number;
  body: string;
}

export function sendRequest(input: SendRequestInput): Promise<SendRequestOutput> {
  return invoke<SendRequestOutput>("send_request", { input });
}
