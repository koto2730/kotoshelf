/** Path/naming helpers for the shared attachments folder.
 *
 * Convention (matches kotomemo): images live in an `attachments/` folder
 * next to the markdown file, and the inserted reference is relative
 * (`![](attachments/img-....png)`) so notes stay portable when the
 * folder moves. The folder name will become configurable when the
 * settings system lands (Phase 7); hardcoded until then. */

export const ATTACHMENTS_DIR = "attachments";

export function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  // No separator means this path has no parent to slice off - a
  // workspace-root-relative SSH path like "test.md" (an absolute local
  // path always has at least one separator, so this case is SSH-only).
  // Returning the input unchanged here used to hand back "test.md"
  // itself as though it were the containing directory, so an
  // attachments/ path built from it became "test.md/attachments" -
  // `mkdir -p` on that fails because test.md is a file, not a
  // directory. "" is this app's convention for the SSH relative root
  // (see joinPath below).
  return idx >= 0 ? normalized.slice(0, idx) : "";
}

/** Empty parts are dropped rather than joined, so joining onto a
 * relative root ("" - what an SSH workspace's own root is, since its
 * tree paths are relative to the remote folder) yields "foo.md" and not
 * a leading-slash "/foo.md" that would read as absolute. */
export function joinPath(...parts: string[]): string {
  return parts
    .filter((p) => p.length > 0)
    .join("/")
    .replace(/\/{2,}/g, "/");
}

/** img-YYYYMMDD-HHmmss (no extension). Second-resolution is enough for
 * hand-driven pastes; collisions within the same second get a suffix. */
export function timestampImageStem(date: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `img-${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

/** A bare (non-`<...>`-wrapped) Markdown image/link destination ends at
 * the first whitespace, so a dropped file's original OS name (screenshot
 * tools commonly produce names with spaces, e.g. "Screen Shot ....png")
 * would silently truncate `![](attachments/name with spaces.png)` at
 * "name" and leave the rest as stray trailing text. Collapse anything
 * that isn't safe in both a bare Markdown destination and a shell-quoted
 * remote path down to "-". */
export function sanitizeAttachmentName(name: string): string {
  return name.replace(/[^\w.-]+/g, "-");
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);

export function extensionOf(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : "";
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
};

/** Used to build a `data:` URI for an image fetched as raw bytes (SSH
 * preview images, which have no local file for the browser to sniff a
 * type from the way a normal <img src="file://..."> would). */
export function mimeTypeOf(path: string): string {
  return IMAGE_MIME_TYPES[extensionOf(path)] ?? "application/octet-stream";
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
