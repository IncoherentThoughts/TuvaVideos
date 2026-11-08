// yt-dlp argument builder for one Download item (downloader-spec §4.3). Pure.

export type Source = "youtube" | "instagram" | "rutube";
export type Quality = "720p" | "1080p" | "best";
export type MergeFormat = "mp4" | "mkv";
export type Cookies = { file: string } | { browser: string };

/** Output templates keep the provenance names `parseFilename` reads back (src/server/filename.ts). */
export const OUTPUT_TEMPLATES: Record<Source, string> = {
  youtube: "%(title).150B [%(id)s].%(ext)s",
  instagram: "%(title).150B [instagram-%(id)s].%(ext)s",
  rutube: "%(title).150B [rutube-%(id)s].%(ext)s",
};

export const SELECTORS: Record<Quality, string> = {
  "720p": "bv*[height<=720][vcodec~='^(avc1|vp0?9)']+ba[acodec~='^(mp4a|opus)']/b[height<=720]",
  "1080p": "bv*[height<=1080][vcodec~='^(avc1|vp0?9)']+ba[acodec~='^(mp4a|opus)']/b[height<=1080]",
  best: "bv*+ba/b",
};

export const PROGRESS_TEMPLATE =
  "download:TUVA %(progress.status)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s";
export const POSTPROCESS_TEMPLATE = "postprocess:TUVAPP %(progress.status)s";
export const FILE_PRINT = "after_move:TUVAFILE %(filepath)s";

export function sourceOf(url: string): Source | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  const is = (d: string) => host === d || host.endsWith(`.${d}`);
  if (is("youtube.com") || is("youtu.be")) return "youtube";
  if (is("instagram.com")) return "instagram";
  if (is("rutube.ru")) return "rutube";
  return null;
}

export function mergeFormatFor(videoCodec: string | null): MergeFormat {
  return videoCodec?.toLowerCase().startsWith("avc1") ? "mp4" : "mkv";
}

export interface ArgSpec {
  url: string;
  source: Source;
  quality: Quality;
  ffmpegLocation: string;
  /** Path to deno (or another runtime yt-dlp understands as `deno:<path>`); omitted when none exists. */
  jsRuntime?: string | null;
  /** From the sizing pass; omitted for single-file formats. */
  mergeFormat?: MergeFormat | null;
  /** Instagram retry only (§5). */
  cookies?: Cookies | null;
  windows?: boolean;
}

const COMMON = ["--no-colors", "--no-update", "--no-playlist"];

function runtimeArgs(spec: Pick<ArgSpec, "ffmpegLocation" | "jsRuntime">): string[] {
  return ["--ffmpeg-location", spec.ffmpegLocation, ...(spec.jsRuntime ? ["--js-runtimes", `deno:${spec.jsRuntime}`] : [])];
}

function cookieArgs(c: Cookies | null | undefined): string[] {
  if (!c) return [];
  return "file" in c ? ["--cookies", c.file] : ["--cookies-from-browser", c.browser];
}

/** The sizing pass: extraction only, one JSON object on stdout. */
export function buildSizingArgs(spec: Omit<ArgSpec, "mergeFormat">): string[] {
  return [...COMMON, ...runtimeArgs(spec), "--simulate", "-J", "-f", SELECTORS[spec.quality], ...cookieArgs(spec.cookies), spec.url];
}

/** The download itself. Run with cwd = the destination. */
export function buildDownloadArgs(spec: ArgSpec): string[] {
  return [
    "--newline",
    ...COMMON,
    "--continue",
    "--part",
    "--no-overwrites",
    "--no-mtime",
    "--retries",
    "10",
    "--fragment-retries",
    "10",
    "--retry-sleep",
    "exp=1:30",
    ...runtimeArgs(spec),
    "-f",
    SELECTORS[spec.quality],
    ...(spec.mergeFormat ? ["--merge-output-format", spec.mergeFormat] : []),
    "-o",
    OUTPUT_TEMPLATES[spec.source],
    ...(spec.windows ? ["--windows-filenames"] : []),
    // `--print` implies `--quiet`, which silences the progress templates unless `--progress` is given (smoke run, #200).
    "--progress",
    "--progress-template",
    PROGRESS_TEMPLATE,
    "--progress-template",
    POSTPROCESS_TEMPLATE,
    "--print",
    FILE_PRINT,
    "--no-simulate",
    ...cookieArgs(spec.cookies),
    spec.url,
  ];
}
