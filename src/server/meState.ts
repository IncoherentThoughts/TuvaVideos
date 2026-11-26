// Resume and Favorites follow you (docs/home-server-spec.md §6), against one machine's library.db: what changed since
// a time, a write from another machine applied newest-wins, the Favorites file, and the first-connect replace. Used by
// the Home Server to answer `/api/me/*` and by a Mac to apply what it pulls or imports.
import type { Db } from "./db";
import { setChapterFavorite, setVideoLocal } from "./localCopy/rows";
import { localIdentities } from "./homeVideos";
import { matchHome, type Identity } from "../shared/homeIndex";
import { chapterStartMs, newer, type FavoritesFile, type MeFavorite, type MeReplaceFavorites, type MeResume, type MeStateDto } from "../shared/meState";

/** Resolves Video identities (§6.1: id, else `youtube_id`, else `content_hash`) to this machine's Video ids. */
export class Resolver {
  private local: Identity[];
  constructor(db: Db) {
    this.local = localIdentities(db);
  }
  one(v: Identity): string | null {
    return matchHome(this.local, [v]).get(v.id) ?? null;
  }
}

export type Applied = "applied" | "older" | "unknown";

const now = () => new Date().toISOString();

/** A Video's identity on this machine. */
export function identityOf(db: Db, videoId: string): Identity | null {
  const r = db.query("SELECT id, youtube_id, content_hash FROM video_full WHERE id = ?").get(videoId) as { id: string; youtube_id: string | null; content_hash: string | null } | null;
  return r ? { id: r.id, youtubeId: r.youtube_id, contentHash: r.content_hash } : null;
}

/** This machine's Resume of a Video, as sent (null when none was ever set). */
export function resumeOf(db: Db, videoId: string): MeResume | null {
  const video = identityOf(db, videoId);
  const r = db.query("SELECT resume_s, resume_at FROM video_local WHERE video_id = ?").get(videoId) as { resume_s: number | null; resume_at: string | null } | null;
  return video && r?.resume_at ? { video, resumeS: r.resume_s, resumeAt: r.resume_at } : null;
}

/** This machine's Favorite of a Video or a Chapter, as sent (null when never starred or unstarred since 0027). */
export function favoriteOf(db: Db, kind: "video" | "chapter", id: string): MeFavorite | null {
  if (kind === "video") {
    const video = identityOf(db, id);
    const r = db.query("SELECT favorited_at, favorite_at FROM video_local WHERE video_id = ?").get(id) as { favorited_at: string | null; favorite_at: string | null } | null;
    return video && r?.favorite_at ? { video, startMs: null, favoritedAt: r.favorited_at, favoriteAt: r.favorite_at } : null;
  }
  const c = db.query("SELECT c.video_id, c.start_s, l.favorited_at, l.favorite_at FROM chapter_full c JOIN chapter_local l ON l.chapter_id = c.id WHERE c.id = ?").get(id) as {
    video_id: string;
    start_s: number;
    favorited_at: string | null;
    favorite_at: string | null;
  } | null;
  const video = c ? identityOf(db, c.video_id) : null;
  return video && c?.favorite_at ? { video, startMs: chapterStartMs(c.start_s), favoritedAt: c.favorited_at, favoriteAt: c.favorite_at } : null;
}

/** `GET /api/me/state?since=`: the rows whose Resume or Favorite changed here after `since` (this machine's clock). */
export function stateSince(db: Db, since: string | null): MeStateDto {
  const at = now();
  const s = since ?? "";
  const vids = db
    .query(
      `SELECT v.id, v.youtube_id, v.content_hash, l.resume_s, l.resume_at, l.favorited_at, l.favorite_at
       FROM video_local l JOIN video_full v ON v.id = l.video_id WHERE COALESCE(l.me_changed_at, '') > ? AND l.me_changed_at <= ?`,
    )
    .all(s, at) as { id: string; youtube_id: string | null; content_hash: string | null; resume_s: number | null; resume_at: string | null; favorited_at: string | null; favorite_at: string | null }[];
  const chs = db
    .query(
      `SELECT v.id, v.youtube_id, v.content_hash, c.start_s, l.favorited_at, l.favorite_at
       FROM chapter_local l JOIN chapter_full c ON c.id = l.chapter_id JOIN video_full v ON v.id = c.video_id
       WHERE COALESCE(l.me_changed_at, '') > ? AND l.me_changed_at <= ? AND l.favorite_at IS NOT NULL`,
    )
    .all(s, at) as { id: string; youtube_id: string | null; content_hash: string | null; start_s: number; favorited_at: string | null; favorite_at: string }[];
  const idOf = (r: { id: string; youtube_id: string | null; content_hash: string | null }): Identity => ({ id: r.id, youtubeId: r.youtube_id, contentHash: r.content_hash });
  return {
    now: at,
    resume: vids.filter((r) => r.resume_at).map((r) => ({ video: idOf(r), resumeS: r.resume_s, resumeAt: r.resume_at! })),
    favorites: [
      ...vids.filter((r) => r.favorite_at).map((r) => ({ video: idOf(r), startMs: null, favoritedAt: r.favorited_at, favoriteAt: r.favorite_at! })),
      ...chs.map((r) => ({ video: idOf(r), startMs: chapterStartMs(r.start_s), favoritedAt: r.favorited_at, favoriteAt: r.favorite_at })),
    ],
  };
}

/** Another machine's Resume, newest wins (§6.1). */
export function applyResume(db: Db, res: Resolver, r: MeResume): Applied {
  const id = res.one(r.video);
  if (!id) return "unknown";
  const cur = db.query("SELECT resume_at FROM video_local WHERE video_id = ?").get(id) as { resume_at: string | null } | null;
  if (!newer(r.resumeAt, cur?.resume_at)) return "older";
  setVideoLocal(db, id, { resume_s: r.resumeS, resume_at: r.resumeAt, last_played_at: r.resumeAt, me_changed_at: now() });
  return "applied";
}

/** The Chapter of a Video starting at `startMs` (§6.1: Chapters are keyed by Video identity and start in ms). */
function chapterAt(db: Db, videoId: string, startMs: number): string | null {
  const rows = db.query("SELECT id, start_s FROM chapter_full WHERE video_id = ? AND suggested = 0").all(videoId) as { id: string; start_s: number }[];
  return rows.find((c) => chapterStartMs(c.start_s) === startMs)?.id ?? null;
}

/** Another machine's star or unstar, newest wins (§6.1). */
export function applyFavorite(db: Db, res: Resolver, f: MeFavorite): Applied {
  const vid = res.one(f.video);
  if (!vid) return "unknown";
  if (f.startMs == null) {
    const cur = db.query("SELECT favorite_at FROM video_local WHERE video_id = ?").get(vid) as { favorite_at: string | null } | null;
    if (!newer(f.favoriteAt, cur?.favorite_at)) return "older";
    setVideoLocal(db, vid, { favorited_at: f.favoritedAt, favorite_at: f.favoriteAt, me_changed_at: now() });
    return "applied";
  }
  const ch = chapterAt(db, vid, f.startMs);
  if (!ch) return "unknown";
  const cur = db.query("SELECT favorite_at FROM chapter_local WHERE chapter_id = ?").get(ch) as { favorite_at: string | null } | null;
  if (!newer(f.favoriteAt, cur?.favorite_at)) return "older";
  setChapterFavorite(db, ch, f.favoritedAt, f.favoriteAt);
  return "applied";
}

/** This machine's Favorites as a file (§6.2): Video identity, Chapter start, `favorited_at`, and titles for the reader. */
export function favoritesFile(db: Db, machine: string): FavoritesFile {
  type Row = { id: string; youtube_id: string | null; content_hash: string | null; title: string; start_s: number | null; chapter_title: string | null; favorited_at: string };
  const rows = db
    .query(
      `SELECT id, youtube_id, content_hash, title, NULL AS start_s, NULL AS chapter_title, favorited_at FROM video_full WHERE favorited_at IS NOT NULL
       UNION ALL
       SELECT v.id, v.youtube_id, v.content_hash, v.title, c.start_s, c.title, c.favorited_at FROM chapter_full c JOIN video_full v ON v.id = c.video_id WHERE c.favorited_at IS NOT NULL
       ORDER BY favorited_at DESC`,
    )
    .all() as Row[];
  return {
    app: "TuvaVideos",
    kind: "favorites",
    version: 1,
    exportedAt: now(),
    machine,
    favorites: rows.map((r) => ({
      id: r.id, youtubeId: r.youtube_id, contentHash: r.content_hash, title: r.title,
      startMs: r.start_s == null ? null : chapterStartMs(r.start_s), chapterTitle: r.chapter_title, favoritedAt: r.favorited_at,
    })),
  };
}

/** Import Favorites… (§6.2): each starred entry of a file, newest wins against what is here. Answers what changed. */
export function importFavorites(db: Db, file: FavoritesFile): { applied: MeFavorite[]; older: number; unknown: number } {
  const res = new Resolver(db);
  const out = { applied: [] as MeFavorite[], older: 0, unknown: 0 };
  db.transaction(() => {
    for (const e of file.favorites) {
      const f: MeFavorite = { video: { id: e.id, youtubeId: e.youtubeId ?? null, contentHash: e.contentHash ?? null }, startMs: e.startMs ?? null, favoritedAt: e.favoritedAt, favoriteAt: e.favoritedAt };
      const r = applyFavorite(db, res, f);
      if (r === "applied") out.applied.push(f);
      else out[r]++;
    }
  })();
  return out;
}

/**
 * First connect (§6.2), on the Home Server: the laptop's Favorites replace this machine's. A Favorite not in the set
 * is unstarred, one in it is starred with the laptop's `favorited_at` (its place in the order); each change is stamped
 * `at`, so it wins over every earlier star elsewhere. Videos and Chapters this machine does not have are counted.
 */
export function replaceFavorites(db: Db, body: MeReplaceFavorites, at = now()): { starred: number; unstarred: number; unknown: number } {
  const res = new Resolver(db);
  const out = { starred: 0, unstarred: 0, unknown: 0 };
  db.transaction(() => {
    const wantVideo = new Map<string, string>();
    const wantChapter = new Map<string, string>();
    for (const f of body.favorites) {
      const vid = res.one(f.video);
      const ch = vid && f.startMs != null ? chapterAt(db, vid, f.startMs) : null;
      if (!vid || (f.startMs != null && !ch)) out.unknown++;
      else if (ch) wantChapter.set(ch, f.favoritedAt);
      else wantVideo.set(vid, f.favoritedAt);
    }
    for (const r of db.query("SELECT id, favorited_at FROM video_full WHERE favorited_at IS NOT NULL").all() as { id: string; favorited_at: string }[]) {
      if (wantVideo.has(r.id)) continue;
      setVideoLocal(db, r.id, { favorited_at: null, favorite_at: at, me_changed_at: at });
      out.unstarred++;
    }
    for (const r of db.query("SELECT id FROM chapter_full WHERE favorited_at IS NOT NULL").all() as { id: string }[]) {
      if (wantChapter.has(r.id)) continue;
      setChapterFavorite(db, r.id, null, at);
      out.unstarred++;
    }
    for (const [id, fav] of wantVideo) {
      const cur = db.query("SELECT favorited_at FROM video_full WHERE id = ?").get(id) as { favorited_at: string | null } | null;
      if (cur?.favorited_at === fav) continue;
      setVideoLocal(db, id, { favorited_at: fav, favorite_at: at, me_changed_at: at });
      out.starred++;
    }
    for (const [id, fav] of wantChapter) {
      const cur = db.query("SELECT favorited_at FROM chapter_full WHERE id = ?").get(id) as { favorited_at: string | null } | null;
      if (cur?.favorited_at === fav) continue;
      setChapterFavorite(db, id, fav, at);
      out.starred++;
    }
  })();
  return out;
}
