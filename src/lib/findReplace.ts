/** Pure find/replace matching over a string of editor text. Mirrors
 * kotomemo's FindMatchesCommand/ReplaceAllCommand (same regex
 * conventions: MULTILINE so ^/$ anchor per line rather than only at
 * buffer edges, DOTALL left off so "." doesn't cross lines) so behavior
 * stays consistent between the two apps. Kept editor-agnostic (plain
 * string in, offsets out) so App.tsx can splice results into a
 * CodeMirror EditorView with view.dispatch. */

export interface Match {
  from: number;
  to: number;
}

export interface FindReplaceState {
  visible: boolean;
  mode: "find" | "replace";
  query: string;
  replacement: string;
  regex: boolean;
  caseSensitive: boolean;
  /** Restricts Find/Replace to this range instead of the whole buffer.
   * Captured once from the editor's selection when the bar opens (see
   * App.tsx's toggleFind/toggleReplace) - not updated as Find Next moves
   * the selection to highlight matches, since that would collapse the
   * scope down to a single match after the first jump. null means
   * "whole document". */
  scope: Match | null;
  lastMatchCount: number;
  /** -1 means "no replace has run yet in this session" (nothing to report). */
  lastReplaceCount: number;
  wrapped: boolean;
  /** Bumped on every open/mode-switch so the bar's query input can
   * re-focus itself via a useEffect keyed on this value - the bar must
   * grab focus explicitly (autoFocus won't refire on an already-mounted
   * input) since CodeMirror otherwise keeps DOM focus underneath it. */
  focusTick: number;
}

export const initialFindReplaceState: FindReplaceState = {
  visible: false,
  mode: "find",
  query: "",
  replacement: "",
  regex: false,
  caseSensitive: false,
  scope: null,
  lastMatchCount: 0,
  lastReplaceCount: -1,
  wrapped: false,
  focusTick: 0,
};

function compilePattern(query: string, regex: boolean, caseSensitive: boolean): RegExp | null {
  if (!query) return null;
  const flags = `gm${caseSensitive ? "" : "i"}`;
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

export function findAllMatches(
  text: string,
  query: string,
  regex: boolean,
  caseSensitive: boolean,
): Match[] {
  const pattern = compilePattern(query, regex, caseSensitive);
  if (!pattern) return [];
  const matches: Match[] = [];
  for (const m of text.matchAll(pattern)) {
    if (m.index == null) continue;
    matches.push({ from: m.index, to: m.index + m[0].length });
  }
  return matches;
}

/** $1/$2 backreferences and \-escapes in a regex replacement template.
 * Not delegated to String.replace's own $-substitution because that
 * only fires when the replacement argument is a plain string, and a
 * literal (non-regex) replacement must NOT have its $ signs
 * reinterpreted - so both modes go through this same explicit walk,
 * with literal mode just returning the template untouched by skipping
 * this function entirely (see replaceAllText below). */
function expandBackreferences(template: string, match: RegExpMatchArray): string {
  let out = "";
  let i = 0;
  while (i < template.length) {
    const c = template[i];
    if (c === "\\" && i + 1 < template.length) {
      out += template[i + 1];
      i += 2;
    } else if (c === "$" && i + 1 < template.length && /[0-9]/.test(template[i + 1])) {
      let end = i + 2;
      while (end < template.length && /[0-9]/.test(template[end])) end++;
      const idx = Number(template.slice(i + 1, end));
      const group = match[idx];
      out += typeof group === "string" ? group : "";
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export function replaceAllText(
  text: string,
  query: string,
  replacement: string,
  regex: boolean,
  caseSensitive: boolean,
): { text: string; count: number } {
  const pattern = compilePattern(query, regex, caseSensitive);
  if (!pattern) return { text, count: 0 };
  let count = 0;
  let out = "";
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    if (m.index == null) continue;
    out += text.slice(last, m.index);
    out += regex ? expandBackreferences(replacement, m) : replacement;
    last = m.index + m[0].length;
    count++;
  }
  out += text.slice(last);
  return { text: out, count };
}
