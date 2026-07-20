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
  return idx >= 0 ? normalized.slice(0, idx) : normalized;
}

export function joinPath(...parts: string[]): string {
  return parts.join("/").replace(/\/{2,}/g, "/");
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

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"]);

export function extensionOf(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : "";
}

export function isImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
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
