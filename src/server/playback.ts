// ffprobe output -> Copy facts and the `playback` decision. Pure.

export type Playback = "native" | "remux" | "transcode";

export const NATIVE_AUDIO = new Set(["aac", "opus", "vorbis", "mp3", "flac"]);

export interface ProbeFacts {
  hasVideo: boolean;
  duration: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  width: number | null;
  height: number | null;
  rFrameRate: string | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  duration?: string;
  disposition?: { attached_pic?: number };
}
export interface FfprobeJson {
  streams?: FfprobeStream[];
  format?: { duration?: string };
}

const positive = (x: unknown): number | null => {
  const n = typeof x === "number" ? x : parseFloat(String(x));
  return Number.isFinite(n) && n > 0 ? n : null;
};

export function parseProbe(json: FfprobeJson): ProbeFacts {
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const rate = v?.r_frame_rate && v.r_frame_rate !== "0/0" ? v.r_frame_rate : null;
  return {
    hasVideo: !!v,
    duration: positive(json.format?.duration) ?? (v ? positive(v.duration) : null),
    videoCodec: v?.codec_name ?? null,
    audioCodec: a?.codec_name ?? null,
    width: v?.width ?? null,
    height: v?.height ?? null,
    rFrameRate: rate,
  };
}

/** Spec 3.4. An audio codec the browser cannot decode wins over a missing duration. */
export function decidePlayback(f: Pick<ProbeFacts, "duration" | "audioCodec">): Playback {
  if (f.audioCodec && !NATIVE_AUDIO.has(f.audioCodec.toLowerCase())) return "transcode";
  if (f.duration == null || !(f.duration > 0)) return "remux";
  return "native";
}

/** "30000/1001" -> 29.97; null when absent or malformed. */
export function frameRateValue(r: string | null): number | null {
  if (!r) return null;
  const [n, d] = r.split("/").map(Number);
  if (!n || !Number.isFinite(n)) return null;
  const v = d ? n / d : n;
  return Number.isFinite(v) && v > 0 ? v : null;
}
