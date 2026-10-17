// The TV Playback profile's per-Copy result (docs/tv-spec.md 3.1): judged from the facts ffprobe stored at scan time,
// kept in copy.tv_playback (JSON) with the profile version in copy.tv_profile_version. No file is read here.
import type { Db } from "./db";
import { extensionOf } from "./filename";
import { frameRateValue } from "./playback";
import { decideTvPlayback, TV_PROFILE, type CopyFacts, type PlaybackProfile, type TvDecision } from "../shared/playbackProfile";

interface Row {
  id: number;
  rel_path: string;
  video_codec: string | null;
  audio_codec: string | null;
  width: number | null;
  height: number | null;
  r_frame_rate: string | null;
}

export const factsOfRow = (r: Pick<Row, "rel_path" | "video_codec" | "audio_codec" | "width" | "height" | "r_frame_rate">): CopyFacts => ({
  ext: extensionOf(r.rel_path),
  videoCodec: r.video_codec,
  audioCodec: r.audio_codec,
  width: r.width,
  height: r.height,
  frameRate: frameRateValue(r.r_frame_rate),
});

/**
 * Judges every Copy whose result is missing (new or changed Copies, a fresh migration) or was made under another
 * profile version. Cheap and local to the database, so it runs at startup and at the end of every scan.
 */
export function judgeStaleCopies(db: Db, profile: PlaybackProfile = TV_PROFILE): number {
  const rows = db
    .query("SELECT id, rel_path, video_codec, audio_codec, width, height, r_frame_rate FROM copy WHERE tv_playback IS NULL OR tv_profile_version IS NOT ?")
    .all(profile.version) as Row[];
  if (!rows.length) return 0;
  const set = db.prepare("UPDATE copy SET tv_playback = ?, tv_profile_version = ? WHERE id = ?");
  db.transaction(() => {
    for (const r of rows) set.run(JSON.stringify(decideTvPlayback(factsOfRow(r), profile)), profile.version, r.id);
  })();
  return rows.length;
}

export function parseDecision(json: string | null): TvDecision | null {
  if (!json) return null;
  try {
    const d = JSON.parse(json) as TvDecision;
    return d && typeof d.video === "string" && typeof d.audio === "string" ? d : null;
  } catch {
    return null;
  }
}
