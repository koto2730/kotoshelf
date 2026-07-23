/** Template-variable evaluation (Phase 5). Static/insert-time only: typing
 * `{{today}}` and closing the braces replaces it with the evaluated value
 * immediately, the same way kotomemo's HTTP preset templates work. No
 * dynamic re-evaluation on file open, and no template-file generation -
 * both are later phases (see work/spec.md).
 */

export interface TemplateContext {
  filename: string; // basename without extension
  workspace: string; // workspace folder's own basename
  /** Markdown source of the current buffer, used to derive {{title}}. */
  content: string;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

function formatDate(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * {{title}} priority: YAML frontmatter `title:` field, then the first
 * ATX heading (# ...), then the filename - matches spec 2.5.
 */
function deriveTitle(content: string, filename: string): string {
  const frontmatterMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (frontmatterMatch) {
    const titleLine = frontmatterMatch[1]
      .split(/\r?\n/)
      .find((line) => /^title\s*:/.test(line));
    if (titleLine) {
      const value = titleLine.slice(titleLine.indexOf(":") + 1).trim();
      // Strip a single layer of quotes: title: "My Note" -> My Note.
      const unquoted = value.replace(/^["'](.*)["']$/, "$1");
      if (unquoted) return unquoted;
    }
  }
  const headingMatch = content.match(/^#{1,6}\s+(.+)$/m);
  if (headingMatch) return headingMatch[1].trim();
  return filename;
}

/**
 * Evaluate one {{...}} expression (without the braces). Returns null for
 * anything unrecognised so the caller can leave the raw text alone rather
 * than silently eating a user's literal "{{whatever}}".
 */
export function evaluateTemplateVar(
  expr: string,
  ctx: TemplateContext,
  now: Date = new Date(),
): string | null {
  const trimmed = expr.trim();

  if (trimmed === "today") return formatDate(now);
  if (trimmed === "now") return `${formatDate(now)} ${formatTime(now)}`;
  if (trimmed === "time") return formatTime(now);
  if (trimmed === "title") return deriveTitle(ctx.content, ctx.filename);
  if (trimmed === "filename") return ctx.filename;
  if (trimmed === "workspace") return ctx.workspace;

  // {{yyyy-mm-dd:N}} - day offset, N may be negative, 0, or omitted (":0").
  const offsetMatch = trimmed.match(/^yyyy-mm-dd:(-?\d+)$/);
  if (offsetMatch) {
    const days = parseInt(offsetMatch[1], 10);
    const shifted = new Date(now);
    shifted.setDate(shifted.getDate() + days);
    return formatDate(shifted);
  }

  return null;
}

/**
 * If `textBeforeCursor` ends with a just-closed `{{...}}`, return the
 * evaluated replacement and how many characters back the `{{` starts.
 * Used by the CodeMirror input handler: called after each keystroke,
 * looks backward from the cursor for the nearest unmatched `{{`.
 */
export function findTemplateVarToExpand(
  textBeforeCursor: string,
  ctx: TemplateContext,
  now: Date = new Date(),
): { start: number; replacement: string } | null {
  if (!textBeforeCursor.endsWith("}}")) return null;
  const openIdx = textBeforeCursor.lastIndexOf("{{");
  if (openIdx === -1) return null;
  const expr = textBeforeCursor.slice(openIdx + 2, textBeforeCursor.length - 2);
  // Reject multi-line spans - a `{{` several paragraphs up closing here
  // is almost certainly two unrelated pieces of text, not a template var.
  if (expr.includes("\n")) return null;
  const value = evaluateTemplateVar(expr, ctx, now);
  if (value === null) return null;
  return { start: openIdx, replacement: value };
}
