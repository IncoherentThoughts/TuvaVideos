// Reads the sizing pass (`yt-dlp --simulate -J`) into exact bytes and the video codec (downloader-spec §4.2). Pure.

import { mergeFormatFor, type MergeFormat } from "./args";

export interface Sizing {
  /** Σ per-stream `filesize` (else `filesize_approx`); null when any stream has neither (HLS/DASH). */
  exactBytes: number | null;
  /** Codec family of the chosen video stream, e.g. `avc1`, `vp09`, `av01`; null when unknown. */
  videoCodec: string | null;
  /** null for a single-file format (nothing to merge). */
  mergeFormat: MergeFormat | null;
  durationS: number | null;
}

interface Fmt {
  filesize?: number | null;
  filesize_approx?: number | null;
  vcodec?: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null);
const sizeOf = (f: Fmt) => num(f.filesize) ?? num(f.filesize_approx);

export function parseSizing(json: string | object): Sizing {
  const info = (typeof json === "string" ? JSON.parse(json) : json) as Fmt & { requested_formats?: Fmt[]; duration?: number | null };
  const streams = info.requested_formats?.length ? info.requested_formats : null;
  const parts = (streams ?? [info]).map(sizeOf);
  const exactBytes = parts.every((p) => p !== null) ? parts.reduce((a, b) => a! + b!, 0) : null;
  const video = streams?.find((f) => f.vcodec && f.vcodec !== "none") ?? (streams ? null : info);
  const vc = video?.vcodec && video.vcodec !== "none" ? video.vcodec : null;
  const videoCodec = vc ? vc.split(".")[0]!.toLowerCase() : null;
  return {
    exactBytes,
    videoCodec,
    mergeFormat: streams && streams.length > 1 ? mergeFormatFor(videoCodec) : null,
    durationS: num(info.duration),
  };
}
