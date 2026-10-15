// Identity and skip rules read from a filename. Pure.

export const VIDEO_EXTENSIONS = new Set(["mp4", "mkv", "webm", "mov", "m4v"]);

export type SkipReason = "ds-store" | "apple-double" | "partial" | "not-video";

export interface ParsedName {
  skip: SkipReason | null;
  ext: string;
  /** The 11-character id in `[...]` just before the extension, if any. */
  youtubeId: string | null;
  /** The shortcode in yt-dlp's `[instagram-<shortcode>]` suffix, if any. Provenance, not identity (ADR 0005). */
  instagramId: string | null;
  /** Filename minus extension and minus the `[id]` (or yt-dlp's `[instagram-<shortcode>]`). */
  title: string;
}

const YT_RE = /\[([A-Za-z0-9_-]{11})\]$/;
// yt-dlp's Instagram downloads end `[instagram-<shortcode>]`; untitled posts are named `Instagram video #<shortcode>`.
// Not an identity (those Videos are known by content hash), but recorded as provenance and used to match a re-download (ADR 0005).
const IG_RE = /\s*\[instagram-([A-Za-z0-9_-]+)\]$/;
// yt-dlp leftovers: `.f303.webm`, `.part`, `.part-Frag3`, `.temp.mp4`, `.ytdl`
const PARTIAL_SEGMENT = /^(f\d+|part|part-frag\d+|temp|ytdl)$/i;

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function parseFilename(name: string): ParsedName {
  const ext = extensionOf(name);
  const stem = ext ? name.slice(0, name.length - ext.length - 1) : name;
  const base: Omit<ParsedName, "skip"> = { ext, youtubeId: null, instagramId: null, title: stem };
  if (name === ".DS_Store") return { ...base, skip: "ds-store" };
  if (name.startsWith("._")) return { ...base, skip: "apple-double" };
  const segments = name.split(".").slice(1);
  if (segments.some((s) => PARTIAL_SEGMENT.test(s))) return { ...base, skip: "partial" };
  if (!VIDEO_EXTENSIONS.has(ext)) return { ...base, skip: "not-video" };
  const ig = stem.match(IG_RE);
  if (ig) {
    let title = stem.slice(0, ig.index).trim();
    if (title.endsWith(`#${ig[1]}`)) title = title.slice(0, -ig[1]!.length - 1).trim();
    return { ...base, skip: null, instagramId: ig[1]!, title: title || stem };
  }
  const m = stem.match(YT_RE);
  if (!m) return { ...base, skip: null };
  return { skip: null, ext, youtubeId: m[1]!, instagramId: null, title: stem.slice(0, m.index).trim() || stem };
}

export function containerFor(ext: string): string {
  return ext === "mkv" || ext === "webm" || ext === "mp4" ? ext : ext === "m4v" || ext === "mov" ? "mp4" : ext;
}

export function contentTypeFor(ext: string): string {
  switch (ext.toLowerCase()) {
    case "webm":
      return "video/webm";
    case "mkv":
      return "video/x-matroska";
    case "mp4":
    case "m4v":
    case "mov":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}
