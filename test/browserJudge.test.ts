// The browser Playback profile is re-judged when it changes (audit PLAY-8), from the stored ffprobe facts.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BROWSER_PROFILE_VERSION, judgeBrowserCopies } from "../src/server/browserJudge";
import { openDb } from "../src/server/db";
import { insertCopy, insertVideo } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");

function setup() {
  const db = openDb(":memory:", MIGRATIONS);
  db.query("INSERT INTO root (id, path, kind) VALUES (1, '/lib', 'local')").run();
  insertVideo(db, { id: 1, content_hash: "h", title: "T", created_at: "x" });
  // judged native by an older rule that played AC-3; the current rule transcodes it
  insertCopy(db, { id: 1, video_id: 1, root_id: 1, rel_path: "a.mkv", audio_codec: "ac3", duration_s: 10, playback: "native" });
  // a Fallback made when AAC was not native: the current rule plays the file as-is
  insertCopy(db, { id: 2, video_id: 1, root_id: 1, rel_path: "b.mp4", audio_codec: "aac", duration_s: 10, playback: "transcode", fallback_file: "2.mp4" });
  insertCopy(db, { id: 3, video_id: 1, root_id: 1, rel_path: "c.mp4", audio_codec: "aac", duration_s: 10, playback: "native" });
  return db;
}
const rows = (db: any) => db.query("SELECT id, playback, fallback_file, playback_profile_version AS v FROM copy ORDER BY id").all();

describe("browser profile re-judging", () => {
  test("rows under no or an older version are re-decided; a changed verdict drops its Fallback", () => {
    const db = setup();
    expect(judgeBrowserCopies(db)).toEqual({ judged: 3, changed: 2 });
    const v = BROWSER_PROFILE_VERSION;
    expect(rows(db)).toEqual([
      { id: 1, playback: "transcode", fallback_file: null, v },
      { id: 2, playback: "native", fallback_file: null, v },
      { id: 3, playback: "native", fallback_file: null, v },
    ]);
    expect(judgeBrowserCopies(db)).toEqual({ judged: 0, changed: 0 }); // stamped: nothing to do next start
  });

  test("a new profile version re-judges every Copy again", () => {
    const db = setup();
    judgeBrowserCopies(db);
    expect(judgeBrowserCopies(db, BROWSER_PROFILE_VERSION + 1)).toEqual({ judged: 3, changed: 0 });
  });
});
