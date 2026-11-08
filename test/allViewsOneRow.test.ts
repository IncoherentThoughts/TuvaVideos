// Migration 0021: a Local row the share turned into a Proposed one keeps its uuid, and the `*_all` views list that id
// once, as the Proposed row. Before, a Video linked to such an Artist got it twice (a plain tag and a "proposed" one)
// and removing any of its Artists sent the duplicate to `write_video_artists replace` (23505).
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { artistKind, songKind } from "../src/server/localCopy/rows";
import { insertLocalArtist, insertVideo, LA } from "./helpers/seed";

const dir = mkdtempSync(join(tmpdir(), "tuva-allviews-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a Local Artist, Song and Version shared as Proposed rows appear once, as Proposed", () => {
  const db = openDb(join(dir, "library.db"), join(import.meta.dir, "..", "migrations"));
  const now = new Date().toISOString();
  const artist = insertLocalArtist(db, { id: 1, name: "Ensemble Daia" });
  db.query("INSERT INTO video_proposed_artists (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)").run(artist, "Ensemble Daia", now, now);
  const video = insertVideo(db, { title: "Концерт", youtube_id: "abcdefghijk" });
  db.query("INSERT INTO video_artists (id, video_id, proposed_artist_id, position, suggested, updated_at) VALUES (?, ?, ?, 0, 0, ?)").run(crypto.randomUUID(), video, artist, now);

  expect(db.query("SELECT kind FROM artist_all WHERE id = ?").all(artist)).toEqual([{ kind: "proposed" }]);
  expect(artistKind(db, artist)).toBe("proposed");
  expect((db.query("SELECT COUNT(*) n FROM video_artist_full va JOIN artist_all a ON a.id = va.artist_id WHERE va.video_id = ?").get(video) as { n: number }).n).toBe(1);
  // a Local Artist with no Proposed twin is still listed as local
  const other = insertLocalArtist(db, { name: "Только здесь" });
  expect(artistKind(db, other)).toBe("local");
  expect(LA(1)).toBe(artist);

  const song = "53000000-0000-4000-8000-000000000001";
  db.query("INSERT INTO local_song (id, name, created_at) VALUES (?, 'Песня', ?)").run(song, now);
  db.query("INSERT INTO video_proposed_songs (id, name, created_at, updated_at) VALUES (?, 'Песня', ?, ?)").run(song, now, now);
  expect(db.query("SELECT kind FROM song_all WHERE id = ?").all(song)).toEqual([{ kind: "proposed" }]);
  expect(songKind(db, song)).toBe("proposed");
  db.close();
});
