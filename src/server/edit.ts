// Header edits on Now playing (spec 5.3): title, Type, Song/Version, Artists, and creating a Local Artist.
// An edit turns the Suggested flag off and stamps the source `manual`; a rescan never overwrites it (scan.ts only
// writes new Videos). Confirming a Suggested value is the same call with the same value.
import type { Db } from "./db";
import { fillLatinTitles, latinFor } from "./latin";
import { reindexVideo } from "./search";
import { TYPES } from "../shared/filters";
import type { VideoPatch } from "../shared/types";

export type EditResult<T = void> = ({ ok: true } & (T extends void ? {} : { value: T })) | { ok: false; status: number; error: string };
const bad = (error: string, status = 400): { ok: false; status: number; error: string } => ({ ok: false, status, error });

export function patchVideo(db: Db, id: number, body: VideoPatch & Record<string, unknown>): EditResult {
  const cur = db.query("SELECT id, title, type, song_id, version_id FROM video WHERE id = ?").get(id) as
    | { id: number; title: string; type: string; song_id: string | null; version_id: string | null }
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
      if (body.songId && !db.query("SELECT 1 FROM mirror_song WHERE id = ?").get(body.songId)) return bad("unknown song (import the Mirror first?)", 404);
      if ((body.songId ?? null) !== song) version = null; // a different Song starts on its default Version
      song = body.songId ?? null;
    }
    if ("versionId" in body) {
      if (body.versionId !== null && typeof body.versionId !== "string") return bad("versionId must be a string or null");
      if (body.versionId) {
        if (!song) return bad("versionId needs a Song");
        if (!db.query("SELECT 1 FROM mirror_version WHERE id = ? AND song_id = ?").get(body.versionId, song)) return bad("that Version does not belong to the Song");
      }
      version = body.versionId ?? null;
    }
    set("song_id", song);
    set("version_id", version);
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
    db.prepare(`UPDATE video SET ${[...cols.keys()].map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.values(), id);
    fillLatinTitles(db, { videoId: id }); // a new title or Song may change its Latin form; `manual` is skipped
    reindexVideo(db, id);
  })();
  return { ok: true };
}

/** Replaces a Video's Artists with `ids`, in order. Unknown ids are refused; duplicates collapse to the first. */
export function setVideoArtists(db: Db, videoId: number, ids: unknown): EditResult {
  if (!db.query("SELECT 1 FROM video WHERE id = ?").get(videoId)) return bad("no such video", 404);
  if (!Array.isArray(ids) || !ids.every((x) => Number.isInteger(x))) return bad("artistIds must be an array of artist ids");
  const order = [...new Set(ids as number[])];
  for (const a of order) if (!db.query("SELECT 1 FROM artist WHERE id = ?").get(a)) return bad(`no such artist: ${a}`, 404);
  db.transaction(() => {
    db.prepare("DELETE FROM video_artist WHERE video_id = ?").run(videoId);
    const ins = db.prepare("INSERT INTO video_artist (video_id, artist_id, position) VALUES (?, ?, ?)");
    order.forEach((a, i) => ins.run(videoId, a, i));
  })();
  return { ok: true };
}

export interface CreatedArtist {
  id: number;
  name: string;
  created: boolean;
}

/** Renames a Local Artist. A Mirror Artist's name belongs to the archive (the import would put it back). */
export function renameLocalArtist(db: Db, id: number, nameRaw: unknown): EditResult<{ id: number; name: string }> {
  const name = typeof nameRaw === "string" ? nameRaw.trim().replace(/\s+/g, " ") : "";
  if (!name) return bad("name must be a non-empty string");
  if (name.length > 200) return bad("name is too long");
  const row = db.query("SELECT id, mirror_id FROM artist WHERE id = ?").get(id) as { id: number; mirror_id: string | null } | null;
  if (!row) return bad("no such Artist", 404);
  if (row.mirror_id) return bad("this Artist's name comes from the archive; merge a Local Artist into it instead", 409);
  const want = name.toLowerCase();
  const clash = (db.query("SELECT id, name FROM artist WHERE id != ?").all(id) as { id: number; name: string }[]).find((a) => a.name.toLowerCase() === want);
  if (clash) return bad(`an Artist named ${clash.name} already exists; use merge into…`, 409);
  const { latin, source } = latinFor(name, null);
  db.prepare("UPDATE artist SET name = ?, name_latin = ?, name_latin_source = ? WHERE id = ?").run(name, latin, source, id);
  return { ok: true, value: { id, name } };
}

/** Creates a Local Artist (`mirror_id` NULL). A name that already exists (case-insensitively) returns that Artist instead. */
export function createLocalArtist(db: Db, nameRaw: unknown): EditResult<CreatedArtist> {
  const name = typeof nameRaw === "string" ? nameRaw.trim().replace(/\s+/g, " ") : "";
  if (!name) return bad("name must be a non-empty string");
  if (name.length > 200) return bad("name is too long");
  // SQLite's lower() is ASCII-only, so the case-insensitive compare happens here (a few hundred Artists).
  const want = name.toLowerCase();
  const same = (db.query("SELECT id, name FROM artist ORDER BY mirror_id IS NULL, id").all() as { id: number; name: string }[]).find((a) => a.name.toLowerCase() === want) ?? null;
  if (same) return { ok: true, value: { id: same.id, name: same.name, created: false } };
  const { latin, source } = latinFor(name, null);
  const id = Number(db.prepare("INSERT INTO artist (mirror_id, name, name_latin, name_latin_source) VALUES (NULL, ?, ?, ?)").run(name, latin, source).lastInsertRowid);
  return { ok: true, value: { id, name, created: true } };
}
