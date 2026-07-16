import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Rendered Markdown preview (right pane). GFM enabled: tables, task
 * lists, strikethrough, autolinks.
 *
 * Phase 3 additions still pending here:
 *  - relative image paths (attachments/) need the Tauri asset protocol
 *    to load from disk, so they render as broken images for now
 *  - [[wiki links]] render as literal text until workspace resolution
 */
export function PreviewPane({ content }: { content: string }) {
  return (
    <div className="prose prose-sm prose-slate dark:prose-invert max-w-none p-4">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
}
