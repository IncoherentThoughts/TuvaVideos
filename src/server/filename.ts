// Identity and skip rules read from a filename. Pure.

export const VIDEO_EXTENSIONS = new Set(["mp4", "mkv", "webm", "mov", "m4v"]);

export type SkipReason = "ds-store" | "apple-double" | "partial" | "not-video";

export interface ParsedName {
  skip: SkipReason | null;
  ext: string;
  /** The 11-character id in `[...]` just before the extension, if any. */
  youtubeId: string | null;
  /** Filename minus extension and minus the `[id]`. */
  title: string;
}

const YT_RE = /\[([A-Za-z0-9_-]{11})\]$/;
// yt-dlp leftovers: `.f303.webm`, `.part`, `.part-Frag3`, `.temp.mp4`, `.ytdl`
const PARTIAL_SEGMENT = /^(f\d+|part|part-frag\d+|temp|ytdl)$/i;

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

export function parseFilename(name: string): ParsedName {
  const ext = extensionOf(name);
  const stem = ext ? name.slice(0, name.length - ext.length - 1) : name;
  const base: Omit<ParsedName, "skip"> = { ext, youtubeId: null, title: stem };
  if (name === ".DS_Store") return { ...base, skip: "ds-store" };
  if (name.startsWith("._")) return { ...base, skip: "apple-double" };
  const segments = name.split(".").slice(1);
  if (segments.some((s) => PARTIAL_SEGMENT.test(s))) return { ...base, skip: "partial" };
  if (!VIDEO_EXTENSIONS.has(ext)) return { ...base, skip: "not-video" };
  const m = stem.match(YT_RE);
  if (!m) return { ...base, skip: null };
  return { skip: null, ext, youtubeId: m[1]!, title: stem.slice(0, m.index).trim() || stem };
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
