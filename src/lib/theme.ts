import { invoke } from "@tauri-apps/api/core";

/** Colors a theme JSON file (~/.kotoshelf/themes/*.json) may define.
 * Every field is optional - anything missing falls back to the
 * built-in light or dark theme's value, so a hand-written theme file
 * can override just one or two colors without redefining the rest. */
export interface ThemeColors {
  dark?: boolean;
  editorBackground?: string;
  editorForeground?: string;
  cursor?: string;
  selection?: string;
  gutterBackground?: string;
  gutterForeground?: string;
  // Live Preview / syntax colors (map to the cm-lp-* classes in
  // editor/livePreview.ts).
  heading?: string;
  strong?: string;
  em?: string;
  strike?: string;
  inlineCode?: string;
  inlineCodeBackground?: string;
  codeblockBackground?: string;
  blockquoteBackground?: string;
  blockquoteBorder?: string;
  quoteMark?: string;
  listMark?: string;
  taskDone?: string;
  link?: string;
  wikilink?: string;
  footnote?: string;
  hr?: string;
}

export interface ResolvedTheme {
  name: string;
  dark: boolean;
  colors: Required<Omit<ThemeColors, "dark">>;
}

const LIGHT_BASE: Required<Omit<ThemeColors, "dark">> = {
  editorBackground: "#ffffff",
  editorForeground: "#1e293b",
  cursor: "#3b82f6",
  selection: "#bfdbfe",
  gutterBackground: "#f8fafc",
  gutterForeground: "#94a3b8",
  heading: "#0f172a",
  strong: "#0f172a",
  em: "#0f172a",
  strike: "#64748b",
  inlineCode: "#0f172a",
  inlineCodeBackground: "#e2e8f0",
  codeblockBackground: "#f1f5f9",
  blockquoteBackground: "#f8fafc",
  blockquoteBorder: "#cbd5e1",
  quoteMark: "#94a3b8",
  listMark: "#f59e0b",
  taskDone: "#64748b",
  link: "#3b82f6",
  wikilink: "#8b5cf6",
  footnote: "#f59e0b",
  hr: "#94a3b8",
};

const DARK_BASE: Required<Omit<ThemeColors, "dark">> = {
  editorBackground: "#0f172a",
  editorForeground: "#e2e8f0",
  cursor: "#60a5fa",
  selection: "#1e40af",
  gutterBackground: "#0f172a",
  gutterForeground: "#475569",
  heading: "#f1f5f9",
  strong: "#f1f5f9",
  em: "#f1f5f9",
  strike: "#94a3b8",
  inlineCode: "#e2e8f0",
  inlineCodeBackground: "#334155",
  codeblockBackground: "#1e293b",
  blockquoteBackground: "#0f172a",
  blockquoteBorder: "#475569",
  quoteMark: "#64748b",
  listMark: "#fbbf24",
  taskDone: "#94a3b8",
  link: "#60a5fa",
  wikilink: "#a78bfa",
  footnote: "#fbbf24",
  hr: "#475569",
};

export const BUILTIN_LIGHT: ResolvedTheme = { name: "light", dark: false, colors: LIGHT_BASE };
export const BUILTIN_DARK: ResolvedTheme = { name: "dark", dark: true, colors: DARK_BASE };

export function listCustomThemes(): Promise<string[]> {
  return invoke<string[]>("list_custom_themes");
}

async function readCustomTheme(name: string): Promise<ThemeColors | null> {
  try {
    return await invoke<ThemeColors>("read_custom_theme", { name });
  } catch {
    return null;
  }
}

export function getSelectedTheme(): Promise<string> {
  return invoke<string>("get_selected_theme");
}

export function setSelectedTheme(name: string): Promise<void> {
  return invoke("set_selected_theme", { name });
}

/**
 * Resolves a theme selection ("light" | "dark" | "system" | a custom
 * theme's name) into a concrete color set. "system" follows the OS
 * preference passed in as `systemPrefersDark`. A custom theme's `dark`
 * field picks which built-in it falls back to for any color it doesn't
 * override.
 */
export async function resolveTheme(
  selection: string,
  systemPrefersDark: boolean,
): Promise<ResolvedTheme> {
  if (selection === "light") return BUILTIN_LIGHT;
  if (selection === "dark") return BUILTIN_DARK;
  if (selection === "system") return systemPrefersDark ? BUILTIN_DARK : BUILTIN_LIGHT;

  const custom = await readCustomTheme(selection);
  if (!custom) {
    // Theme file missing/invalid (deleted after being selected, etc.) -
    // fall back to system rather than silently erroring.
    return systemPrefersDark ? BUILTIN_DARK : BUILTIN_LIGHT;
  }
  const base = custom.dark ? DARK_BASE : LIGHT_BASE;
  return {
    name: selection,
    dark: custom.dark ?? false,
    colors: { ...base, ...stripUndefined(custom) },
  };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
