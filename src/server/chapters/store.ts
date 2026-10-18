// Chapter reads and writes behind the Now playing filmstrip (spec 5.3, 8). SQL only; routing is api.ts.
//
// Rules in one place:
// - A Suggested Chapter is `suggested = 1` with its source. Confirming clears the flag and keeps the source.
// - Rejecting (or deleting) a Suggested Chapter deletes the row and writes the tombstone (video, source, start_s);
//   deleting a confirmed or manual Chapter leaves none.
// - Editing the title or the start of a Suggested Chapter confirms it (the person has taken it over); moving it also
//   tombstones the old start so the next suggest run does not bring it back. Attaching a Song does not confirm.
// - UNIQUE (video_id, start_s): a start that is taken is refused with a message, never silently nudged.
import type { Db } from "../db";
import { fillLatinTitles } from "../latin";
import { reindexChapter } from "../search";
import { songRef } from "../songs";
import { newUuid } from "../localCopy/ids";
import { nowIso, setChapterFavorite, songPointers } from "../localCopy/rows";
import { clampStart, formatStart } from "../../shared/timestamps";
import type { ChapterCreate, ChapterDto, ChapterPatch } from "../../shared/types";

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const bad = (error: string, status = 400): { ok: false; status: number; error: string } => ({ ok: false, status, error });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

/** A `chapter_full` row: one effective pointer per pair, this machine's Favorite. */
export interface ChapterRow {
  id: string;
  video_id: string;
  start_s: number;
  title: string;
  title_latin: string | null;
  song_id: string | null;
  version_id: string | null;
  suggested: number;
  source: ChapterDto["source"];
  favorited_at: string | null;
  updated_at: string;
}

export function chapterDto(db: Db, c: ChapterRow): ChapterDto {
  return {
    id: c.id, videoId: c.video_id, startS: c.start_s, title: c.title, titleLatin: c.title_latin, suggested: !!c.suggested,
    source: c.source, songId: c.song_id, versionId: c.version_id, song: songRef(db, c.song_id), favoritedAt: c.favorited_at, updatedAt: c.updated_at,
  };
}

const getRow = (db: Db, id: string) => db.query("SELECT * FROM chapter_full WHERE id = ?").get(id) as ChapterRow | null;
const videoExists = (db: Db, id: string) => !!db.query("SELECT 1 FROM video_full WHERE id = ?").get(id);

export function listChapters(db: Db, videoId: string): ChapterDto[] | null {
  if (!videoExists(db, videoId)) return null;
  return (db.query("SELECT * FROM chapter_full WHERE video_id = ? ORDER BY start_s, id").all(videoId) as ChapterRow[]).map((c) => chapterDto(db, c));
}

export function getChapter(db: Db, id: string): ChapterDto | null {
  const c = getRow(db, id);
  return c ? chapterDto(db, c) : null;
}

const maxDuration = (db: Db, videoId: string) => (db.query("SELECT MAX(duration_s) d FROM copy WHERE video_id = ?").get(videoId) as { d: number | null }).d;

function checkStart(db: Db, videoId: string, raw: unknown, exceptId?: string): Result<number> {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return bad("startS must be a number of seconds >= 0");
  const dur = maxDuration(db, videoId);
  const s = clampStart(raw, null);
  if (dur != null && s > dur + 0.5) return bad(`that time is past the end of the Video (${formatStart(dur)})`);
  const clash = db.query("SELECT id FROM video_chapters WHERE video_id = ? AND start_s = ?").get(videoId, s) as { id: string } | null;
  if (clash && clash.id !== exceptId) return bad(`a Chapter already starts at ${formatStart(s)}`, 409);
  return ok(s);
}

function checkSong(db: Db, songId: unknown, versionId: unknown, current: { song_id: string | null; version_id: string | null }): Result<{ song: string | null; version: string | null }> {
  let song = current.song_id;
  let version = current.version_id;
  if (songId !== undefined) {
    if (songId !== null && typeof songId !== "string") return bad("songId must be a string or null");
    if (songId && !db.query("SELECT 1 FROM song_all WHERE id = ?").get(songId)) return bad("unknown song (Sync the archive first, or add a local Song)", 404);
    if ((songId ?? null) !== song) version = null; // a different Song starts on its default Version
    song = songId ?? null;
  }
  if (versionId !== undefined) {
    if (versionId !== null && typeof versionId !== "string") return bad("versionId must be a string or null");
    if (versionId) {
      if (!song) return bad("versionId needs a Song");
      if (!db.query("SELECT 1 FROM version_all WHERE id = ? AND song_id = ?").get(versionId, song)) return bad("that Version does not belong to the Song");
    }
    version = versionId ?? null;
  }
  return ok({ song, version });
}

export function addChapter(db: Db, videoId: string, body: Partial<ChapterCreate> & Record<string, unknown>): Result<ChapterDto> {
  if (!videoExists(db, videoId)) return bad("no such video", 404);
  const start = checkStart(db, videoId, body.startS);
  if (!start.ok) return start;
  if (body.title !== undefined && typeof body.title !== "string") return bad("title must be a string");
  const title = cleanTitle(body.title ?? "");
  if (title.length > 500) return bad("title is too long");
  const song = checkSong(db, body.songId, body.versionId, { song_id: null, version_id: null });
  if (!song.ok) return song;
  const id = db.transaction(() => {
    const id = newUuid();
    const p = songPointers(db, song.value.song, song.value.version);
    db.prepare(
      `INSERT INTO video_chapters (id, video_id, start_s, title, song_id, proposed_song_id, version_id, proposed_version_id, suggested, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'manual', ?)`,
    ).run(id, videoId, start.value, title, p.song_id, p.proposed_song_id, p.version_id, p.proposed_version_id, nowIso());
    fillLatinTitles(db, { chapterId: id });
    reindexChapter(db, id);
    return id;
  })();
  return ok(getChapter(db, id)!);
}

const cleanTitle = (t: string) => t.trim().replace(/\s+/g, " ");

/** Tombstones a rejected Chapter suggestion (video, source, start) so the next suggest run does not bring it back. */
export function rejectChapterAt(db: Db, videoId: string, source: string, startS: number) {
  const now = nowIso();
  db.prepare("INSERT OR IGNORE INTO video_chapter_rejections (id, video_id, source, start_s, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)").run(newUuid(), videoId, source, startS, now, now);
}

export function patchChapter(db: Db, id: string, body: ChapterPatch & Record<string, unknown>): Result<ChapterDto> {
  const cur = getRow(db, id);
  if (!cur) return bad("no such chapter", 404);
  const cols = new Map<string, string | number | null>();
  let confirms = false;
  let moved: number | null = null;

  if ("title" in body) {
    if (typeof body.title !== "string") return bad("title must be a string");
    const t = cleanTitle(body.title);
    if (t.length > 500) return bad("title is too long");
    if (t !== cur.title) {
      cols.set("title", t);
      cols.set("title_latin_source", null); // handed back to the generator below
      confirms = true;
    }
  }
  if ("startS" in body) {
    const s = checkStart(db, cur.video_id, body.startS, id);
    if (!s.ok) return s;
    if (s.value !== cur.start_s) {
      cols.set("start_s", s.value);
      moved = cur.start_s;
      confirms = true;
    }
  }
  if ("songId" in body || "versionId" in body) {
    const song = checkSong(db, body.songId, body.versionId, cur);
    if (!song.ok) return song;
    for (const [k, v] of Object.entries(songPointers(db, song.value.song, song.value.version))) cols.set(k, v);
  }
  if (!cols.size) return ok(chapterDto(db, cur));
  db.transaction(() => {
    if (confirms && cur.suggested) cols.set("suggested", 0);
    if (moved != null && cur.suggested) rejectChapterAt(db, cur.video_id, cur.source, moved);
    db.prepare(`UPDATE video_chapters SET ${[...cols.keys()].map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.values(), id);
    fillLatinTitles(db, { chapterId: id });
    reindexChapter(db, id);
  })();
  return ok(getChapter(db, id)!);
}

/** Deletes a Chapter. A Suggested one is a rejection: the tombstone is written. */
export function deleteChapter(db: Db, id: string): Result<{ deleted: true; tombstoned: boolean; videoId: string }> {
  const cur = getRow(db, id);
  if (!cur) return bad("no such chapter", 404);
  db.transaction(() => {
    if (cur.suggested) rejectChapterAt(db, cur.video_id, cur.source, cur.start_s);
    db.prepare("DELETE FROM video_chapters WHERE id = ?").run(id);
    reindexChapter(db, id);
  })();
  return ok({ deleted: true, tombstoned: !!cur.suggested, videoId: cur.video_id });
}

/** POST /reject: only a Suggested Chapter can be rejected. */
export function rejectChapter(db: Db, id: string): Result<{ rejected: true; videoId: string }> {
  const cur = getRow(db, id);
  if (!cur) return bad("no such chapter", 404);
  if (!cur.suggested) return bad("only a Suggested Chapter can be rejected (DELETE removes a confirmed one)", 409);
  const r = deleteChapter(db, id);
  return r.ok ? ok({ rejected: true, videoId: r.value.videoId }) : r;
}

export function confirmChapter(db: Db, id: string): Result<ChapterDto> {
  const cur = getRow(db, id);
  if (!cur) return bad("no such chapter", 404);
  if (cur.suggested) db.prepare("UPDATE video_chapters SET suggested = 0 WHERE id = ?").run(id);
  return ok(getChapter(db, id)!);
}

export function confirmAll(db: Db, videoId: string): Result<{ confirmed: number; chapters: ChapterDto[] }> {
  if (!videoExists(db, videoId)) return bad("no such video", 404);
  // counted first: `.changes` would also count the rows the updated_at trigger touches
  const n = (db.query("SELECT COUNT(*) n FROM video_chapters WHERE video_id = ? AND suggested = 1").get(videoId) as { n: number }).n;
  db.prepare("UPDATE video_chapters SET suggested = 0 WHERE video_id = ? AND suggested = 1").run(videoId);
  return ok({ confirmed: n, chapters: listChapters(db, videoId)! });
}
