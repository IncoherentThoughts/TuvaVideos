// The pure half of a Live stream (docs/home-server-spec.md 7.2, docs/tv-spec.md 3.4): the full-length VOD playlist,
// segment arithmetic, what a segment request does (serve, wait, restart), when the encoder pauses and what is pruned,
// the plan (copy or encode, size, bitrate) and the ffmpeg command. No process or file is touched here.
import { LIVE_COPYABLE_VIDEO, type TvDecision } from "../../shared/playbackProfile";
import { LIVE_SEGMENT_S, liveSegmentStarts, shortEdge, type LiveQuality } from "../../shared/liveQuality";

export const SEGMENT_S = LIVE_SEGMENT_S;
/** The encoder runs about this far ahead of the last segment requested, then pauses (60 s). */
export const AHEAD_SEGMENTS = 6;
/** Segments further than this behind the last request are deleted (300 s). */
export const PRUNE_BEHIND_SEGMENTS = 30;
/** A request this many segments past the one being encoded restarts the encoder there instead of waiting. */
export const WAIT_GAP_SEGMENTS = 1;
/** HLS through native `<video>` on Tizen is capped at 1080p (tv-spec 3.4): a larger source is encoded down to it. */
export const TV_MAX_SHORT_EDGE = 1080;
/** Video bitrate per quality, kbit/s, capped at the source's own (home-server-spec 7.2). */
export const LADDER_KBPS: Record<"1080" | "720" | "480", number> = { "1080": 8000, "720": 4000, "480": 1500 };
export const AUDIO_KBPS = 160;
/** Audio a TS segment carries as it is; any other is converted to AAC. */
const COPYABLE_AUDIO = ["aac", "ac3", "eac3", "mp3"];

export const segmentCount = (durationS: number): number => Math.max(1, Math.ceil(durationS / SEGMENT_S - 1e-9));

export function segmentDuration(i: number, durationS: number): number {
  const n = segmentCount(durationS);
  if (i < n - 1) return SEGMENT_S;
  return Math.max(0.001, durationS - SEGMENT_S * (n - 1));
}

/** The segment holding time `t`. */
export const segmentAt = (t: number, durationS: number): number => Math.min(segmentCount(durationS) - 1, Math.max(0, Math.floor(t / SEGMENT_S)));

/** Segment starts, the points a seek over a Live stream snaps to. */
export const segmentStarts = (durationS: number): number[] => liveSegmentStarts(durationS);

/** The whole playlist up front: `ceil(duration/10)` entries, VOD, so the player can seek anywhere at once. */
export function vodPlaylist(durationS: number, q: LiveQuality): string {
  const n = segmentCount(durationS);
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", `#EXT-X-TARGETDURATION:${SEGMENT_S}`, "#EXT-X-MEDIA-SEQUENCE:0", "#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-INDEPENDENT-SEGMENTS"];
  for (let i = 0; i < n; i++) lines.push(`#EXTINF:${segmentDuration(i, durationS).toFixed(3)},`, `seg${i}.ts?q=${q}`);
  lines.push("#EXT-X-ENDLIST", "");
  return lines.join("\n");
}

/** What the encoder has: it started at `start` and has finished every segment below `next`; `low` is the lowest kept. */
export interface ProducedRange {
  start: number;
  next: number;
  low: number;
  /** ffmpeg has exited (finished or failed): nothing more comes without a restart. */
  exited: boolean;
}

/**
 * A request for segment `n`: `ready` when it is on disk; `wait` when the encoder is about to make it; `restart` (kill
 * and start again at `n`) for a jump outside the produced range, behind what was kept or more than a segment ahead.
 */
export function segmentAction(r: ProducedRange | null, n: number, onDisk: boolean): "ready" | "wait" | "restart" {
  if (onDisk) return "ready";
  if (!r || r.exited) return "restart";
  if (n < Math.max(r.start, r.low)) return "restart";
  if (n < r.next) return "restart"; // made and pruned (or lost): make it again
  return n - r.next <= WAIT_GAP_SEGMENTS ? "wait" : "restart";
}

/** Pause once the encoder is AHEAD_SEGMENTS past the last request; run while it is closer. */
export const shouldPause = (next: number, lastRequested: number): boolean => next > lastRequested + AHEAD_SEGMENTS;

/** Segments below this index are deleted. */
export const pruneBelow = (lastRequested: number): number => Math.max(0, lastRequested - PRUNE_BEHIND_SEGMENTS);

// ---- the plan ----

export interface LiveSource {
  durationS: number;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  sizeBytes: number | null;
  /** The player's Playback profile decision for this Copy. */
  decision: TvDecision;
}

export interface LivePlan {
  mode: "copy" | "encode";
  /** The short edge encoded to, null for copy mode. */
  shortEdge: number | null;
  /** Video bitrate in kbit/s, null for copy mode. */
  videoKbps: number | null;
  audio: "copy" | "aac" | "none";
  /** Scale on the height (landscape) or the width (portrait). */
  portrait: boolean;
}

/**
 * Copy mode when the video can go into the segments as it is (only the container or audio is wrong) and no smaller
 * size was picked; encode mode otherwise: at the picked size, or, for Original, at the source's size capped at the
 * player's largest (`maxShortEdge`). A picked size at or above the source's is Original: nothing is scaled up.
 */
export function planLive(src: LiveSource, q: LiveQuality, maxShortEdge = TV_MAX_SHORT_EDGE): LivePlan {
  const edge = shortEdge(src.width, src.height);
  const portrait = !!(src.width && src.height && src.height > src.width);
  const picked = q === "orig" ? null : Number(q);
  const smaller = picked != null && (edge == null || picked < edge) ? picked : null;
  const v = src.videoCodec?.toLowerCase() ?? null;
  const copyable = src.decision.video !== "transcode" && v != null && LIVE_COPYABLE_VIDEO.includes(v) && (edge == null || edge <= maxShortEdge);
  const a = src.audioCodec?.toLowerCase() ?? null;
  if (smaller == null && copyable) {
    return { mode: "copy", shortEdge: null, videoKbps: null, audio: a == null ? "none" : COPYABLE_AUDIO.includes(a) && src.decision.audio !== "transcode" ? "copy" : "aac", portrait };
  }
  const target = Math.min(smaller ?? edge ?? maxShortEdge, maxShortEdge);
  const rung = target > 720 ? LADDER_KBPS["1080"] : target > 480 ? LADDER_KBPS["720"] : LADDER_KBPS["480"];
  const sourceKbps = src.sizeBytes && src.durationS > 0 ? Math.round((src.sizeBytes * 8) / src.durationS / 1000) : null;
  const videoKbps = Math.max(200, sourceKbps != null ? Math.min(rung, sourceKbps) : rung);
  return { mode: "encode", shortEdge: target, videoKbps, audio: a == null ? "none" : "aac", portrait };
}

/** The highest frame rate the encode makes (the TV profile's h264 limit). */
export const ENCODE_MAX_FPS = 60;

/**
 * The ffmpeg command for a run starting at segment `start`, writing `seg<n>.ts` into `dir`. `-ss` before `-i`; copy
 * mode seeks to the keyframe before (`-noaccurate_seek`) and keeps the source's timestamps, encode mode starts exactly
 * there with keyframes forced every 10 s, so the segments of any restart line up with the playlist.
 */
export function ffmpegArgs(plan: LivePlan, input: string, dir: string, start: number): string[] {
  const t = start * SEGMENT_S;
  const args = ["-v", "error", "-nostdin", "-y"];
  if (plan.mode === "copy") args.push("-noaccurate_seek");
  if (t > 0) args.push("-ss", String(t));
  args.push("-i", input, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-map_metadata", "-1", "-map_chapters", "-1");
  if (plan.mode === "copy") {
    args.push("-c:v", "copy", "-copyts", "-start_at_zero", "-avoid_negative_ts", "disabled");
  } else {
    const kbps = plan.videoKbps!;
    const scale = plan.portrait ? `scale=${plan.shortEdge}:-2` : `scale=-2:${plan.shortEdge}`;
    args.push(
      "-c:v", "h264_videotoolbox", "-b:v", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`,
      "-profile:v", "high", "-g", "100000", "-vf", `${scale},format=yuv420p`, "-fpsmax", String(ENCODE_MAX_FPS),
      "-force_key_frames", `expr:gte(t,n_forced*${SEGMENT_S})`,
    );
    if (t > 0) args.push("-output_ts_offset", String(t));
  }
  if (plan.audio === "copy") args.push("-c:a", "copy");
  else if (plan.audio === "aac") args.push("-c:a", "aac", "-b:a", `${AUDIO_KBPS}k`, "-ac", "2");
  args.push(
    "-f", "hls", "-hls_time", String(SEGMENT_S), "-hls_list_size", "0", "-hls_flags", "temp_file",
    "-start_number", String(start), "-hls_segment_filename", `${dir}/seg%d.ts`, `${dir}/ffmpeg.m3u8`,
  );
  return args;
}
