/** Template rendering for API presets (Phase 6) - separate from
 * templateVars.ts (Phase 5), which expands {{today}}/{{title}}/etc. at
 * insert time as the user types in the editor. This renderer expands a
 * preset's URL/body/header templates at send-time, adding two variables
 * templateVars.ts has no use for: {{selection}} (the text being sent),
 * {{tokens.NAME}} (a saved secret/token by name), and {{sessionId}} (a
 * "SessionID: ..." line found in the selection, for continuing a
 * stateful API's session - see the matching comment on ApiPreset's
 * sessionIdPath). Where the two
 * overlap ({{filename}}, {{title}}), the definitions are the same, just
 * duplicated rather than sharing a module - the two call sites have
 * different available context (editor buffer vs. send-time snapshot)
 * and forcing them through one function added more indirection than it
 * saved. Matches kotomemo's usecase/TemplateRenderer.kt behaviour.
 */

export interface RenderContext {
  selection: string;
  filename: string;
  tokens: Record<string, string>;
  /** A "SessionID: ..." line's value, if the selection being sent has
   * one (see extractSessionId) - null when there isn't one. */
  sessionId: string | null;
}

/** Pulls a session id out of a "SessionID: <value>" line, matching the
 * plain-text format App.tsx appends after a response that has one (see
 * ApiPreset.sessionIdPath). Case-sensitive and line-anchored so it only
 * matches that exact convention, not any incidental use of the word
 * "session" in a note. */
export function extractSessionId(text: string): string | null {
  const m = text.match(/^SessionID:[ \t]*(.*)$/m);
  return m ? m[1].trim() || null : null;
}

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

function jsonEscape(s: string): string {
  return JSON.stringify(s).slice(1, -1); // reuse JSON's escaping, strip the wrapping quotes
}

function resolve(key: string, ctx: RenderContext): string | null {
  if (key === "selection") return ctx.selection;
  if (key === "selectionJson") return jsonEscape(ctx.selection);
  if (key === "filename") return ctx.filename;
  if (key.startsWith("tokens.")) {
    const tokenName = key.slice("tokens.".length);
    return ctx.tokens[tokenName] ?? null;
  }
  // Unlike an unrecognised placeholder or a missing {{tokens.NAME}} (both
  // left literal so a typo stays visible), ctx.sessionId being null is
  // the *normal* state for a first send in a new conversation - there's
  // no prior response to have carried a SessionID line yet. Resolving
  // to "" rather than falling through to the literal "{{sessionId}}"
  // text means a body template that always references it (e.g. a
  // stateful API's previous_interaction_id field) still sends a valid
  // request on that first turn.
  if (key === "sessionId") return ctx.sessionId ?? "";
  // For a body template field that should be JSON null (not an empty
  // string) when there's no session yet - e.g. a stateful API that
  // rejects "" for previous_interaction_id/previous_response_id but
  // accepts null. Used unquoted in the template: `"field": {{sessionIdJson}}`,
  // not `"field": "{{sessionIdJson}}"` (that would always produce a
  // string, quoting even the literal `null`).
  if (key === "sessionIdJson") {
    return ctx.sessionId ? JSON.stringify(ctx.sessionId) : "null";
  }
  return null;
}

/** Unrecognised {{placeholder}} is left as literal text (matches
 * kotomemo) so a typo'd token name is visible rather than silently
 * blanked out in the sent request. */
export function renderTemplate(template: string, ctx: RenderContext): string {
  if (!template) return template;
  return template.replace(PLACEHOLDER_RE, (whole, key: string) => {
    const value = resolve(key, ctx);
    return value ?? whole;
  });
}
