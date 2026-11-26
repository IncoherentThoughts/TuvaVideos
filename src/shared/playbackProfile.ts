// Playback profiles as data, and the pure TV decision (docs/tv-spec.md §3.1). Shared by the server (scan-time
// judging) and, later, the TV app. Keyed by file extension, never by ffprobe's container name (webm reads as mkv),
// with limits on the long edge, never a literal height (a portrait 1080x1920 file must pass).

export type TvMode = "directplay" | "copy" | "transcode";

export interface TvDecision {
  video: TvMode;
  /** `transcode` means AAC. */
  audio: TvMode;
  reason: string | null;
}

export interface PlaybackProfile {
  /** Bump when the table changes: every Copy judged under an older version is judged again. */
  version: number;
  rules: Record<string, { video: string[]; audio: string[] }>;
  limits: {
    longEdge: number;
    /** Highest frame rate per video codec. */
    fps: Record<string, number>;
  };
}

const MAIN = { video: ["h264", "hevc", "vp9", "av1"], audio: ["aac", "ac3", "eac3", "opus", "vorbis", "mp3"] };

/** Jellyfin's Tizen rules, confirmed on the R85H by #48. 10-bit is allowed (no pixel-format rule). */
export const TV_PROFILE: PlaybackProfile = {
  /** 2: the decision gained video `transcode` (home-server-spec 7.1), so every Copy is judged again. */
  version: 2,
  rules: { mkv: MAIN, mp4: MAIN, mov: MAIN, m4v: MAIN, webm: { video: ["vp9", "av1"], audio: ["opus", "vorbis"] } },
  limits: { longEdge: 4096, fps: { h264: 60, hevc: 120, vp9: 60, av1: 120 } },
};

export interface CopyFacts {
  /** File extension without the dot, any case. */
  ext: string;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  /** r_frame_rate as a number. */
  frameRate: number | null;
}

/** ffprobe sometimes reports a time base (1000, 90000) as r_frame_rate for variable-rate files; such a value says nothing. */
const BOGUS_FPS = 240;

/** Video a Live stream can copy into its MPEG-TS segments; anything else it re-encodes (home-server-spec 7.1). */
export const LIVE_COPYABLE_VIDEO = ["h264", "hevc"];

/**
 * Video: `directplay` when the profile plays it from this extension; `copy` when only the container is wrong and the
 * Live stream can copy the video into its segments (h264, hevc within the limits); `transcode` for everything else
 * (an unplayable or unknown codec, a long edge or frame rate over the limit): the Live stream re-encodes it.
 */
export function decideTvPlayback(f: CopyFacts, profile: PlaybackProfile): TvDecision {
  const ext = f.ext.toLowerCase();
  const reasons: string[] = [];
  const rule = profile.rules[ext];
  const v = f.videoCodec?.toLowerCase() ?? null;
  const a = f.audioCodec?.toLowerCase() ?? null;

  let video: TvMode = "directplay";
  let audio: TvMode = "directplay";

  const overLimit = (): string | null => {
    const maxFps = v == null ? undefined : profile.limits.fps[v];
    const edge = Math.max(f.width ?? 0, f.height ?? 0);
    if (edge > profile.limits.longEdge) return `long edge ${edge} px is over ${profile.limits.longEdge}`;
    if (maxFps != null && f.frameRate != null && f.frameRate <= BOGUS_FPS && f.frameRate > maxFps + 0.5) return `${Math.round(f.frameRate)} fps is over ${maxFps} for ${v}`;
    return null;
  };

  if (!rule) {
    // The container is not on the table: the Live stream copies the video when it can, else re-encodes it; audio is
    // copied when some container plays it.
    reasons.push(`extension .${ext || "?"} is not in the TV profile`);
    const limit = v != null ? overLimit() : null;
    const played = v != null && Object.values(profile.rules).some((r) => r.video.includes(v));
    video = played && LIVE_COPYABLE_VIDEO.includes(v!) && !limit ? "copy" : "transcode";
    if (v == null) reasons.push("no video codec known");
    else if (limit) reasons.push(limit);
    else if (video === "transcode") reasons.push(`video ${v} cannot be copied into a Live stream`);
    const known = a == null || Object.values(profile.rules).some((r) => r.audio.includes(a));
    audio = known ? "copy" : "transcode";
    if (!known) reasons.push(`audio ${a} is not played by the TV`);
    return { video, audio, reason: reasons.join("; ") };
  }

  if (v == null) {
    video = "transcode";
    reasons.push("no video codec known");
  } else if (!rule.video.includes(v)) {
    video = "transcode";
    reasons.push(`video ${v} is not played from .${ext}`);
  } else {
    const limit = overLimit();
    if (limit) {
      video = "transcode";
      reasons.push(limit);
    }
  }

  if (a != null && !rule.audio.includes(a)) {
    audio = "transcode";
    reasons.push(`audio ${a} is not played from .${ext}`);
  }
  return { video, audio, reason: reasons.length ? reasons.join("; ") : null };
}

export const playsAsIs = (d: TvDecision | null): boolean => d?.video === "directplay" && d.audio === "directplay";

/** spec 3.2: the Copy's own file, else its existing Fallback when the profile plays that, else a Live stream. */
export function tvOrder(own: TvDecision | null, fallback: TvDecision | null): "file" | "fallback" | "live" {
  if (playsAsIs(own)) return "file";
  if (playsAsIs(fallback)) return "fallback";
  return "live";
}

/** What the Fallback file of a Copy holds (fallback.ts: `-c:v copy`, audio AAC when the Copy was `transcode`). */
export function fallbackFacts(copy: CopyFacts, playback: "native" | "remux" | "transcode", fallbackFile: string): CopyFacts {
  const i = fallbackFile.lastIndexOf(".");
  return { ...copy, ext: i < 0 ? "" : fallbackFile.slice(i + 1), audioCodec: playback === "transcode" && copy.audioCodec ? "aac" : copy.audioCodec };
}
