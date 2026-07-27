import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { convertFileSrc } from "@tauri-apps/api/core";
import { joinPath } from "../lib/attachments";

/**
 * Rendered Markdown preview (right pane). GFM enabled: tables, task
 * lists, strikethrough, autolinks.
 *
 * Relative image paths (e.g. attachments/img-x.png) resolve against the
 * active file's directory. A local workspace loads them from disk
 * through Tauri's asset protocol; an SSH workspace has no local file for
 * that protocol to find, so `resolveSshImage` (when provided) fetches
 * the bytes over the connection instead and renders a data: URI.
 * Untitled buffers have no directory, so their relative images stay
 * unresolved until saved.
 */
export function PreviewPane({
  content,
  fileDir,
  resolveSshImage,
}: {
  content: string;
  fileDir: string | null;
  /** Present only for an SSH workspace. Returns null for "can't/won't
   * load this" (too large, fetch failed, or not a workspace-relative
   * path this can resolve) - rendered as a placeholder, not a broken
   * image icon. */
  resolveSshImage?: (relPath: string) => Promise<string | null>;
}) {
  return (
    <div className="prose prose-sm prose-slate dark:prose-invert max-w-none p-4">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => {
            const raw = typeof src === "string" ? src : "";
            if (resolveSshImage) {
              return <SshPreviewImage src={raw} alt={alt ?? ""} fileDir={fileDir} resolve={resolveSshImage} />;
            }
            return (
              <img
                src={resolveLocalImageSrc(raw, fileDir)}
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

/** Resolves one image asynchronously via SSH and renders it once ready.
 * A separate component (not inline state in the `img` render callback)
 * because each markdown image needs its own load/error state - React
 * hooks can't live inside a plain callback. */
function SshPreviewImage({
  src,
  alt,
  fileDir,
  resolve,
}: {
  src: string;
  alt: string;
  fileDir: string | null;
  resolve: (relPath: string) => Promise<string | null>;
}) {
  const relPath = toWorkspaceRelativePath(src, fileDir);
  const [dataUri, setDataUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setDataUri(null);
    setFailed(false);
    if (!relPath) {
      setFailed(true);
      return;
    }
    let cancelled = false;
    void resolve(relPath).then((uri) => {
      if (cancelled) return;
      if (uri) setDataUri(uri);
      else setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [relPath, resolve]);

  if (failed) {
    return (
      <span className="inline-block text-xs italic text-slate-400 border border-dashed border-slate-300 dark:border-slate-700 rounded px-2 py-1">
        [image unavailable{relPath ? `: ${relPath}` : ""}]
      </span>
    );
  }
  if (!dataUri) {
    return <span className="text-xs italic text-slate-400">Loading image…</span>;
  }
  return <img src={dataUri} alt={alt} className="max-w-full rounded" />;
}

/** Mirrors resolveLocalImageSrc's path handling, but only the
 * workspace-relative case makes sense for SSH - there's no local
 * filesystem for an absolute path to mean anything on. */
function toWorkspaceRelativePath(src: string, fileDir: string | null): string | null {
  if (!src || /^(https?:|data:|asset:)/i.test(src)) return null;
  if (/^([a-zA-Z]:[\\/]|\/)/.test(src)) return null;
  if (fileDir === null) return null;
  return joinPath(fileDir, decodeURIComponent(src));
}

function resolveLocalImageSrc(src: string, fileDir: string | null): string {
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
