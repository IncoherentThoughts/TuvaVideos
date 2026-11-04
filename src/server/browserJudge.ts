// The browser Playback profile's per-Copy verdict (`copy.playback`, spec 3.4) re-judged when the rule changes (audit
// PLAY-8): like the TV profile's `tv_profile_version`, each Copy records the version it was judged under, and a
// startup pass re-decides every other row from the facts ffprobe stored (no file is read). A Copy whose verdict changed
// loses its Fallback, which was made for the old verdict; the file left in remux/ is swept by FallbackQueue.verifyFiles.
import type { Db } from "./db";
import { decidePlayback, type Playback } from "./playback";

/** Bump with any change to `decidePlayback` or `NATIVE_AUDIO`. */
export const BROWSER_PROFILE_VERSION = 1;

export function judgeBrowserCopies(db: Db, version = BROWSER_PROFILE_VERSION): { judged: number; changed: number } {
  const rows = db
    .query("SELECT id, duration_s, audio_codec, playback FROM copy WHERE playback_profile_version IS NOT ?")
    .all(version) as { id: number; duration_s: number | null; audio_codec: string | null; playback: Playback }[];
  let changed = 0;
  if (!rows.length) return { judged: 0, changed };
  const same = db.prepare("UPDATE copy SET playback_profile_version = ? WHERE id = ?");
  const set = db.prepare("UPDATE copy SET playback = ?, fallback_file = NULL, playback_profile_version = ? WHERE id = ?");
  db.transaction(() => {
    for (const r of rows) {
      const p = decidePlayback({ duration: r.duration_s, audioCodec: r.audio_codec });
      if (p === r.playback) same.run(version, r.id);
      else (set.run(p, version, r.id), changed++);
    }
  })();
  return { judged: rows.length, changed };
}
