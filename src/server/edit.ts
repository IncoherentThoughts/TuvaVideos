// Header edits on Now playing (spec 5.3): title, Type, Song/Version, Artists, and creating a Local Artist.
// An edit turns the Suggested flag off and stamps the source `manual`; a rescan never overwrites it (scan.ts only
// writes new Videos). Confirming a Suggested value is the same call with the same value. These are the companion's
// routes for an Unshared or Standalone Video (sharing-spec §4.9); a Shared Video is written through the archive.
import type { Db } from "./db";
import { fillLatinTitles, latinFor } from "./latin";
import { reindexVideo } from "./search";
import { TYPES } from "../shared/filters";
import type { VideoPatch } from "../shared/types";
import { newUuid } from "./localCopy/ids";
import { artistPointer, nowIso, songPointers } from "./localCopy/rows";

export type EditResult<T = void> = ({ ok: true } & (T extends void ? {} : { value: T })) | { ok: false; status: number; error: string };
const bad = (error: string, status = 400): { ok: false; status: number; error: string } => ({ ok: false, status, error });

const videoExists = (db: Db, id: string) => !!db.query("SELECT 1 FROM video_full WHERE id = ?").get(id);

export function patchVideo(db: Db, id: string, body: VideoPatch & Record<string, unknown>): EditResult {
  const cur = db.query("SELECT id, title, type, song_id, version_id FROM video_full WHERE id = ?").get(id) as
    | { id: string; title: string; type: string; song_id: string | null; version_id: string | null }
    | null;
  if (!cur) return bad("no such video", 404);

  const cols = new Map<string, string | number | null>();
  const set = (col: string, v: string | number | null) => void cols.set(col, v);

  if ("title" in body) {
    const t = typeof body.title === "string" ? body.title.trim().replace(/\s+/g, " ") : "";
    if (!t) return bad("title must be a non-empty string");
    if (t.length > 500) return bad("title is too long");
    if (t !== cur.title) set("title", t);
  }
  if ("type" in body) {
    if (typeof body.type !== "string" || !(TYPES as readonly string[]).includes(body.type)) return bad(`type must be one of ${TYPES.join(", ")}`);
    set("type", body.type);
    set("type_suggested", 0);
    set("suggestion_source", "manual");
  }
  if ("songId" in body || "versionId" in body) {
    let song = cur.song_id;
    let version = cur.version_id;
    if ("songId" in body) {
      if (body.songId !== null && typeof body.songId !== "string") return bad("songId must be a string or null");
      if (body.songId && !db.query("SELECT 1 FROM song_all WHERE id = ?").get(body.songId)) return bad("unknown song (Sync the archive first, or add a local Song)", 404);
      if ((body.songId ?? null) !== song) version = null; // a different Song starts on its default Version
      song = body.songId ?? null;
    }
    if ("versionId" in body) {
      if (body.versionId !== null && typeof body.versionId !== "string") return bad("versionId must be a string or null");
      if (body.versionId) {
        if (!song) return bad("versionId needs a Song");
        if (!db.query("SELECT 1 FROM version_all WHERE id = ? AND song_id = ?").get(body.versionId, song)) return bad("that Version does not belong to the Song");
      }
      version = body.versionId ?? null;
    }
    for (const [k, v] of Object.entries(songPointers(db, song, version))) set(k, v);
    set("song_suggested", 0);
    set("suggestion_source", "manual");
  }
  if ("titleLatin" in body) {
    const v = body.titleLatin;
    if (v !== null && typeof v !== "string") return bad("titleLatin must be a string or null");
    const t = (v ?? "").trim();
    if (t) {
      set("title_latin", t);
      set("title_latin_source", "manual");
    } else {
      set("title_latin", null);
      set("title_latin_source", null); // handed back to the generator below
    }
  }
  if (!cols.size) return { ok: true };
  db.transaction(() => {
    db.prepare(`UPDATE videos SET ${[...cols.keys()].map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.values(), id);
    fillLatinTitles(db, { videoId: id }); // a new title or Song may change its Latin form; `manual` is skipped
    reindexVideo(db, id);
  })();
  return { ok: true };
}

const insertLink = (db: Db, videoId: string, artistId: string, position: number, suggested: 0 | 1) => {
  const p = artistPointer(db, artistId);
  db.prepare("INSERT INTO video_artists (id, video_id, artist_id, proposed_artist_id, position, suggested, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(newUuid(), videoId, p.artist_id, p.proposed_artist_id, position, suggested, nowIso());
};

/** Tombstones a rejected Artist suggestion so the matcher does not offer it again. */
export function rejectArtistLink(db: Db, videoId: string, artistId: string) {
  const p = artistPointer(db, artistId);
  const held = db.query("SELECT 1 FROM video_artist_rejections WHERE video_id = ? AND (artist_id = ? OR proposed_artist_id = ?)").get(videoId, artistId, artistId);
  if (held) return;
  const now = nowIso();
  db.prepare("INSERT INTO video_artist_rejections (id, video_id, artist_id, proposed_artist_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(newUuid(), videoId, p.artist_id, p.proposed_artist_id, now, now);
}

/** Every Artist link a matcher or an edit writes goes through here: `ids` in order, all with the same Suggested flag. */
export function writeArtistLinks(db: Db, videoId: string, ids: string[], suggested: 0 | 1) {
  ids.forEach((a, i) => insertLink(db, videoId, a, i, suggested));
}

/**
 * Replaces a Video's Artists with `ids`, in order, all confirmed. Unknown ids are refused; duplicates collapse to the
 * first. A Suggested Artist left out of `ids` is a rejection (tombstoned so the matcher does not offer it again).
 */
export function setVideoArtists(db: Db, videoId: string, ids: unknown): EditResult {
  if (!videoExists(db, videoId)) return bad("no such video", 404);
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string" && x)) return bad("artistIds must be an array of artist ids");
  const order = [...new Set(ids as string[])];
  for (const a of order) if (!db.query("SELECT 1 FROM artist_all WHERE id = ?").get(a)) return bad(`no such artist: ${a}`, 404);
  db.transaction(() => {
    const dropped = (db.query("SELECT artist_id FROM video_artist_full WHERE video_id = ? AND suggested = 1").all(videoId) as { artist_id: string }[])
      .map((r) => r.artist_id)
      .filter((a) => !order.includes(a));
    for (const a of dropped) rejectArtistLink(db, videoId, a);
    db.prepare("DELETE FROM video_artists WHERE video_id = ?").run(videoId);
    writeArtistLinks(db, videoId, order, 0);
  })();
  return { ok: true };
}

/** Confirms every Suggested Artist of a Video (they keep their order after the confirmed ones). */
export function confirmVideoArtists(db: Db, videoId: string): EditResult {
  if (!videoExists(db, videoId)) return bad("no such video", 404);
  db.prepare("UPDATE video_artists SET suggested = 0 WHERE video_id = ? AND suggested = 1").run(videoId);
  return { ok: true };
}

/** Removes one Artist from a Video; a Suggested one is tombstoned so the matcher does not offer it again. */
export function rejectVideoArtist(db: Db, videoId: string, artistId: string): EditResult {
  const row = db.query("SELECT link_id, suggested FROM video_artist_full WHERE video_id = ? AND artist_id = ?").get(videoId, artistId) as { link_id: string; suggested: number } | null;
  if (!row) return bad("that Artist is not on this Video", 404);
  db.transaction(() => {
    if (row.suggested) rejectArtistLink(db, videoId, artistId);
    db.prepare("DELETE FROM video_artists WHERE id = ?").run(row.link_id);
  })();
  return { ok: true };
}

export interface CreatedArtist {
  id: string;
  name: string;
  created: boolean;
}

/** Renames a Local Artist. An archive or Proposed Artist's name belongs to the Shared data. */
export function renameLocalArtist(db: Db, id: string, nameRaw: unknown): EditResult<{ id: string; name: string }> {
  const name = typeof nameRaw === "string" ? nameRaw.trim().replace(/\s+/g, " ") : "";
  if (!name) return bad("name must be a non-empty string");
  if (name.length > 200) return bad("name is too long");
  const row = db.query("SELECT id, kind FROM artist_all WHERE id = ?").get(id) as { id: string; kind: string } | null;
  if (!row) return bad("no such Artist", 404);
  if (row.kind !== "local") return bad("this Artist's name comes from the archive; merge a Local Artist into it instead", 409);
  const want = name.toLowerCase();
  const clash = (db.query("SELECT id, name FROM artist_all WHERE id != ?").all(id) as { id: string; name: string }[]).find((a) => a.name.toLowerCase() === want);
  if (clash) return bad(`an Artist named ${clash.name} already exists; use merge into…`, 409);
  const { latin, source } = latinFor(name, null);
  db.transaction(() => {
    db.prepare("UPDATE local_artist SET name = ? WHERE id = ?").run(name, id);
    db.prepare("INSERT INTO artist_latin (artist_id, name_latin, name_latin_source) VALUES (?, ?, ?) ON CONFLICT(artist_id) DO UPDATE SET name_latin = excluded.name_latin, name_latin_source = excluded.name_latin_source")
      .run(id, latin, source);
  })();
  return { ok: true, value: { id, name } };
}

/** Creates a Local Artist (`local_artist`). A name that already exists (case-insensitively) returns that Artist instead. */
export function createLocalArtist(db: Db, nameRaw: unknown): EditResult<CreatedArtist> {
  const name = typeof nameRaw === "string" ? nameRaw.trim().replace(/\s+/g, " ") : "";
  if (!name) return bad("name must be a non-empty string");
  if (name.length > 200) return bad("name is too long");
  // SQLite's lower() is ASCII-only, so the case-insensitive compare happens here (a few hundred Artists).
  const want = name.toLowerCase();
  const same =
    (db.query("SELECT id, name FROM artist_all ORDER BY CASE kind WHEN 'archive' THEN 0 WHEN 'proposed' THEN 1 ELSE 2 END, name").all() as { id: string; name: string }[]).find(
      (a) => a.name.toLowerCase() === want,
    ) ?? null;
  if (same) return { ok: true, value: { id: same.id, name: same.name, created: false } };
  const { latin, source } = latinFor(name, null);
  const id = newUuid();
  db.transaction(() => {
    db.prepare("INSERT INTO local_artist (id, name, created_at) VALUES (?, ?, ?)").run(id, name, nowIso());
    if (latin != null || source != null) db.prepare("INSERT INTO artist_latin (artist_id, name_latin, name_latin_source) VALUES (?, ?, ?)").run(id, latin, source);
  })();
  return { ok: true, value: { id, name, created: true } };
}
