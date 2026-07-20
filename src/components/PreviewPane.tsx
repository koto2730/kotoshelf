import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { convertFileSrc } from "@tauri-apps/api/core";
import { joinPath } from "../lib/attachments";

/**
 * Rendered Markdown preview (right pane). GFM enabled: tables, task
 * lists, strikethrough, autolinks.
 *
 * Relative image paths (e.g. attachments/img-x.png) resolve against the
 * active file's directory and load from disk through Tauri's asset
 * protocol. Untitled buffers have no directory, so their relative images
 * stay unresolved until saved.
 */
export function PreviewPane({
  content,
  fileDir,
}: {
  content: string;
  fileDir: string | null;
}) {
  return (
    <div className="prose prose-sm prose-slate dark:prose-invert max-w-none p-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => {
            const resolved = resolveImageSrc(
              typeof src === "string" ? src : "",
              fileDir,
            );
            return (
              <img
                src={resolved}
                alt={alt ?? ""}
                className="max-w-full rounded"
              />
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

function resolveImageSrc(src: string, fileDir: string | null): string {
  if (!src) return src;
  // Absolute web URLs and data URIs pass through untouched.
  if (/^(https?:|data:|asset:)/i.test(src)) return src;
  // Windows absolute (C:/...) or POSIX absolute paths go straight to the
  // asset protocol.
  if (/^([a-zA-Z]:[\\/]|\/)/.test(src)) return convertFileSrc(src);
  // Relative path: resolve against the markdown file's directory.
  if (!fileDir) return src;
  return convertFileSrc(joinPath(fileDir, decodeURIComponent(src)));
}
