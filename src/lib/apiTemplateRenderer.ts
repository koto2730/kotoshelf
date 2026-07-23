/** Template rendering for API presets (Phase 6) - separate from
 * templateVars.ts (Phase 5), which expands {{today}}/{{title}}/etc. at
 * insert time as the user types in the editor. This renderer expands a
 * preset's URL/body/header templates at send-time, adding two variables
 * templateVars.ts has no use for: {{selection}} (the text being sent)
 * and {{tokens.NAME}} (a saved secret/token by name). Where the two
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
