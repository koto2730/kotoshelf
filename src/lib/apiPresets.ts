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
  responseJsonPath: string | null;
  responseTarget: ResponseTarget;
}

export function newPreset(name: string): ApiPreset {
  return {
    name,
    url: "https://",
    method: "POST",
    headers: [],
    bodyTemplate: "",
    responseJsonPath: null,
    responseTarget: "newTab",
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
