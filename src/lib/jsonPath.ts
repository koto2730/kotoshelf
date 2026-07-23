/** Minimal dotted JSON-path extractor, e.g. "choices.0.message.content"
 * against a parsed JSON response body. Ported from kotomemo's
 * JsonPathExtractor.kt. Numeric segments index arrays; everything else
 * indexes object keys. Returns null on any failure (missing key, index
 * out of range, invalid JSON) so the caller can fall back to the raw
 * body rather than crash on a misconfigured preset.
 */
export function extractJsonPath(rawBody: string, path: string): string | null {
  let node: unknown;
  try {
    node = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const segments = path.split(".").filter(Boolean);
  for (const segment of segments) {
    if (node === null || node === undefined) return null;
    if (Array.isArray(node)) {
      const idx = Number(segment);
      if (!Number.isInteger(idx) || idx < 0 || idx >= node.length) return null;
      node = node[idx];
    } else if (typeof node === "object") {
      if (!(segment in (node as Record<string, unknown>))) return null;
      node = (node as Record<string, unknown>)[segment];
    } else {
      return null;
    }
  }
  if (node === null || node === undefined) return null;
  return typeof node === "string" ? node : JSON.stringify(node);
}
