// Sign-in reconciliation (docs/sharing-spec.md §2.3; ticket #149): a Standalone (or signed-out) library meets the
// Shared set. The pure half matches this machine's Unshared Videos to Shared Videos (YouTube id, then content hash,
// then Instagram shortcode or Rutube id; the same uuid first, as on the owner's migrated machine) and says what each
// match shelves; the SQL half carries it out in the caller's transaction, just before `applyShared` lays the Shared
// rows over the matched Videos:
//   - Shared wins: a matched Video takes the Shared Video's id and row; its Copies, Favorite, resume point, audio
//     state, Studio tracks and the rest of this machine's rows follow it to the Shared id (a provenance match with a
//     different hash so joins the Shared Video as a new Copy; two local Videos meeting one Shared Video merge);
//   - the local link data that loses (title, Type, Song and Version, Artists, Chapters) becomes Shelved edits;
//   - a Favorite Chapter whose Chapter is shelved leaves the Favorites list (the Shelved Chapter keeps `favoritedAt`);
//     one whose Chapter the Shared Video has too (same start, title and pointers) moves to the Shared Chapter;
//   - at sign-in, a Video Editor's unknown Videos are queued to be shared (`pending_share`, §6.6); a Member's stay
//     Unshared. `local_*` Songs, Versions and Artists stay where they are: the Shelved edits point at them.
// It also resolves `applyShared`'s clash refusal (a Shared Video's youtube_id or content_hash held by a local id):
// every Sync runs the matching step before its apply (`reconcileBatch`), so an Unshared Video that someone else's
// share made known reconciles at the next Sync instead of failing it.
//
// `createReconcile` is the two routes: `GET /api/reconcile/preview` (the confirmation's count) and
// `POST /api/reconcile` (Continue). Both call `video_whoami()` with the browser's access token and write the Session
// record; the token is used for those calls only, never stored or logged.
import { renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { changesSince, postgrestClient, tokenExp, whoami, type ArchiveCall, type ArchiveEndpoint, type RpcClient } from "../shared/archive";
import type { VideoWhoami } from "../shared/archiveWire";
import { NO_RECONCILE, type ReconcileCounts, type ReconcileResponse } from "../shared/reconcile";
import { mapNames, videoDiffs, type DiffNames, type DiffNow, type VideoDiff } from "../shared/shelvedDiff";
import { schemaGateLine, type SessionRecord } from "../shared/session";
import type { SharedChanges } from "../shared/sharedRows";
import type { Db } from "./db";
import { applyShared } from "./localCopy/apply";
import { loseEditorGrant, readSessionRecord, SHARED_SCHEMA, setPendingShare, shelve, writeSessionRecord, type ShelvedPayload } from "./localCopy/meta";
import { reindexChapter, reindexVideo } from "./search";

// ---------------------------------------------------------------------------------------------------------------
// The pure half
// ---------------------------------------------------------------------------------------------------------------

export interface ReconcileChapter {
  id: string;
  startS: number;
  title: string;
  titleLatin: string | null;
  /** Effective pointers (a pair's plain or Proposed id). */
  songId: string | null;
  versionId: string | null;
  /** This machine's star (local Videos only). */
  favoritedAt?: string | null;
}

/** A Video as reconciliation compares it: identity, the link data that can lose, and its Chapters. */
export interface ReconcileVideo {
  id: string;
  youtubeId: string | null;
  contentHash: string | null;
  instagramId: string | null;
  rutubeId: string | null;
  title: string;
  titleLatin: string | null;
  type: string | null;
  songId: string | null;
  versionId: string | null;
  /** Effective Artist ids in position order. */
  artistIds: string[];
  chapters: ReconcileChapter[];
}

export type MatchKey = "id" | "youtube_id" | "content_hash" | "instagram_id" | "rutube_id";
/** The scan's order (§2.3, §3.2), after the same uuid. */
export const MATCH_ORDER: MatchKey[] = ["id", "youtube_id", "content_hash", "instagram_id", "rutube_id"];

const keyOf = (v: ReconcileVideo, k: MatchKey): string | null =>
  k === "id" ? v.id : k === "youtube_id" ? v.youtubeId : k === "content_hash" ? v.contentHash : k === "instagram_id" ? v.instagramId : v.rutubeId;

/** Indexes the Shared Videos by every match key (the first Video by id wins a shared provenance value). */
export function sharedIndex(shared: ReconcileVideo[]): Map<MatchKey, Map<string, ReconcileVideo>> {
  const idx = new Map<MatchKey, Map<string, ReconcileVideo>>(MATCH_ORDER.map((k) => [k, new Map()]));
  for (const s of [...shared].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    for (const k of MATCH_ORDER) {
      const v = keyOf(s, k);
      if (v != null && v !== "" && !idx.get(k)!.has(v)) idx.get(k)!.set(v, s);
    }
  }
  return idx;
}

/** The Shared Video a local Video reconciles to, and by which key; null for an unknown Video. */
export function matchVideo(local: ReconcileVideo, idx: Map<MatchKey, Map<string, ReconcileVideo>>): { shared: ReconcileVideo; by: MatchKey } | null {
  for (const k of MATCH_ORDER) {
    const v = keyOf(local, k);
    if (v == null || v === "") continue;
    const s = idx.get(k)!.get(v);
    if (s) return { shared: s, by: k };
  }
  return null;
}

/** A local Chapter the Shared Video also has: same start, same title, and no pointer the Shared one lacks. */
export function sameChapter(l: ReconcileChapter, s: ReconcileChapter): boolean {
  return l.startS === s.startS && l.title.trim() === s.title.trim() && (l.songId == null || l.songId === s.songId) && (l.versionId == null || l.versionId === s.versionId);
}

export interface ShelveResult {
  /** The Shelved edits, in the drawer's order: title, Type, Song, Artists, then Chapters by start. */
  shelved: ShelvedPayload[];
  /** Stars that move to the Shared Chapter (the local Chapter survives as it). */
  stars: { chapterId: string; favoritedAt: string }[];
  /** Favorite Chapters that left the Favorites list with their shelved Chapter. */
  favoritesShelved: number;
}

/**
 * What a matched local Video loses to its Shared Video. Only link data that the Shared row does not already say is
 * shelved: an equal title, an empty or default (`other`) Type, no Song, Artists all among the Shared ones, and
 * Chapters the Shared Video has too lose nothing.
 */
export function shelvedFor(local: ReconcileVideo, shared: ReconcileVideo): ShelveResult {
  const out: ShelveResult = { shelved: [], stars: [], favoritesShelved: 0 };
  if (local.title.trim() !== shared.title.trim()) out.shelved.push({ kind: "title", title: local.title, titleLatin: local.titleLatin });
  if (local.type && local.type !== "other" && local.type !== shared.type) out.shelved.push({ kind: "type", type: local.type });
  if ((local.songId != null || local.versionId != null) && (local.songId !== shared.songId || local.versionId !== shared.versionId)) {
    out.shelved.push({ kind: "song", songId: local.songId, versionId: local.versionId });
  }
  const theirs = new Set(shared.artistIds);
  if (local.artistIds.some((a) => !theirs.has(a))) out.shelved.push({ kind: "artists", artistIds: [...local.artistIds] });
  for (const c of [...local.chapters].sort((a, b) => a.startS - b.startS)) {
    const twin = shared.chapters.find((s) => sameChapter(c, s));
    if (twin) {
      if (c.favoritedAt) out.stars.push({ chapterId: twin.id, favoritedAt: c.favoritedAt });
      continue;
    }
    out.shelved.push({ kind: "chapter", startS: c.startS, title: c.title, songId: c.songId, versionId: c.versionId, favoritedAt: c.favoritedAt ?? null });
    if (c.favoritedAt) out.favoritesShelved++;
  }
  return out;
}

export interface ReconcilePlan {
  /** Local id → Shared id, grouped by the Shared Video in match order (the first local Video of a group is kept). */
  matches: { localId: string; sharedId: string; by: MatchKey }[];
  shelve: { videoId: string; payload: ShelvedPayload }[];
  stars: { chapterId: string; favoritedAt: string }[];
  /** Local Videos the Shared set does not know. */
  unknown: string[];
  favoritesShelved: number;
}

/** Matches every local (Unshared) Video against the Shared set and says what each match shelves. Pure. */
export function planReconcile(locals: ReconcileVideo[], shared: ReconcileVideo[]): ReconcilePlan {
  const idx = sharedIndex(shared);
  const plan: ReconcilePlan = { matches: [], shelve: [], stars: [], unknown: [], favoritesShelved: 0 };
  const rank = (k: MatchKey) => MATCH_ORDER.indexOf(k);
  const found: { local: ReconcileVideo; shared: ReconcileVideo; by: MatchKey }[] = [];
  for (const l of locals) {
    const m = matchVideo(l, idx);
    if (m) found.push({ local: l, ...m });
    else plan.unknown.push(l.id);
  }
  // Within a Shared Video the strongest match is kept first; ties by id, so a plan is the same on every run.
  found.sort((a, b) => (a.shared.id < b.shared.id ? -1 : a.shared.id > b.shared.id ? 1 : rank(a.by) - rank(b.by) || (a.local.id < b.local.id ? -1 : 1)));
  const starred = new Map<string, string>();
  for (const f of found) {
    plan.matches.push({ localId: f.local.id, sharedId: f.shared.id, by: f.by });
    const r = shelvedFor(f.local, f.shared);
    for (const p of r.shelved) plan.shelve.push({ videoId: f.shared.id, payload: p });
    // Two local Videos starring one Shared Chapter: the earlier star stands.
    for (const s of r.stars) if (!starred.has(s.chapterId) || s.favoritedAt < starred.get(s.chapterId)!) starred.set(s.chapterId, s.favoritedAt);
    plan.favoritesShelved += r.favoritesShelved;
  }
  plan.stars = [...starred].map(([chapterId, favoritedAt]) => ({ chapterId, favoritedAt }));
  return plan;
}

/** The counts the confirmation shows (§2.3) for a plan, as a Video Editor (`queueUnknown`) or a Member sees them. */
export function planCounts(plan: ReconcilePlan, queueUnknown: boolean): ReconcileCounts {
  return {
    matched: plan.matches.length,
    shelved: plan.shelve.length,
    shelvedVideos: new Set(plan.shelve.map((s) => s.videoId)).size,
    favoritesShelved: plan.favoritesShelved,
    queued: queueUnknown ? plan.unknown.length : 0,
    unshared: queueUnknown ? 0 : plan.unknown.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading both sides
// ---------------------------------------------------------------------------------------------------------------

type Row = Record<string, any>;

/** The Shared Videos of a batch, with their Chapters and Artist links. */
export function sharedVideos(batch: SharedChanges): ReconcileVideo[] {
  const t = batch.tables ?? {};
  const chapters = new Map<string, ReconcileChapter[]>();
  for (const c of t.video_chapters ?? []) {
    (chapters.get(c.video_id) ?? chapters.set(c.video_id, []).get(c.video_id)!).push({
      id: c.id, startS: Number(c.start_s), title: c.title ?? "", titleLatin: c.title_latin, songId: c.song_id ?? c.proposed_song_id, versionId: c.version_id ?? c.proposed_version_id,
    });
  }
  const artists = new Map<string, { id: string; pos: number }[]>();
  for (const a of t.video_artists ?? []) (artists.get(a.video_id) ?? artists.set(a.video_id, []).get(a.video_id)!).push({ id: (a.artist_id ?? a.proposed_artist_id)!, pos: a.position });
  return (t.videos ?? []).map((v) => ({
    id: v.id, youtubeId: v.youtube_id, contentHash: v.content_hash, instagramId: v.instagram_id, rutubeId: v.rutube_id,
    title: v.title ?? "", titleLatin: v.title_latin, type: v.type, songId: v.song_id ?? v.proposed_song_id, versionId: v.version_id ?? v.proposed_version_id,
    artistIds: (artists.get(v.id) ?? []).sort((a, b) => a.pos - b.pos).map((a) => a.id),
    chapters: chapters.get(v.id) ?? [],
  }));
}

const UNSHARED = "SELECT v.* FROM videos v LEFT JOIN video_local l ON l.video_id = v.id WHERE COALESCE(l.shared, 0) = 0";

/** This machine's Unshared Videos (identity and link data; children only for `withChildren` ids, or all). */
export function localVideos(db: Db, withChildren?: Set<string>): ReconcileVideo[] {
  const rows = db.query(`${UNSHARED} ORDER BY v.id`).all() as Row[];
  const want = (id: string) => !withChildren || withChildren.has(id);
  const chapters = new Map<string, ReconcileChapter[]>();
  const artists = new Map<string, string[]>();
  if (!withChildren || withChildren.size) {
    for (const c of db.query(`SELECT c.*, cl.favorited_at FROM video_chapters c LEFT JOIN chapter_local cl ON cl.chapter_id = c.id
        WHERE c.video_id IN (SELECT v.id FROM (${UNSHARED}) v) ORDER BY c.start_s`).all() as Row[]) {
      if (!want(c.video_id)) continue;
      (chapters.get(c.video_id) ?? chapters.set(c.video_id, []).get(c.video_id)!).push({
        id: c.id, startS: c.start_s, title: c.title, titleLatin: c.title_latin, songId: c.song_id ?? c.proposed_song_id, versionId: c.version_id ?? c.proposed_version_id,
        favoritedAt: c.favorited_at ?? null,
      });
    }
    for (const a of db.query(`SELECT video_id, COALESCE(artist_id, proposed_artist_id) AS a FROM video_artists
        WHERE video_id IN (SELECT v.id FROM (${UNSHARED}) v) ORDER BY position`).all() as Row[]) {
      if (want(a.video_id)) (artists.get(a.video_id) ?? artists.set(a.video_id, []).get(a.video_id)!).push(a.a);
    }
  }
  return rows.map((v) => ({
    id: v.id, youtubeId: v.youtube_id, contentHash: v.content_hash, instagramId: v.instagram_id, rutubeId: v.rutube_id,
    title: v.title, titleLatin: v.title_latin, type: v.type, songId: v.song_id ?? v.proposed_song_id, versionId: v.version_id ?? v.proposed_version_id,
    artistIds: artists.get(v.id) ?? [], chapters: chapters.get(v.id) ?? [],
  }));
}

/** The plan for this machine and a batch: matching on identity first, children read only for the matched Videos. */
export function planFor(db: Db, batch: SharedChanges): ReconcilePlan {
  const shared = sharedVideos(batch);
  if (!shared.length) return { matches: [], shelve: [], stars: [], unknown: localVideos(db, new Set()).map((v) => v.id), favoritesShelved: 0 };
  const idx = sharedIndex(shared);
  const matched = new Set(localVideos(db, new Set()).filter((l) => matchVideo(l, idx)).map((l) => l.id));
  return planReconcile(localVideos(db, matched), shared);
}

/** Names from the Local copy's views (archive, Proposed and local rows alike). */
export function localNames(db: Db): DiffNames {
  const q = (sql: string) => {
    const st = db.prepare(sql);
    return (id: string) => (st.get(id) as { n: string } | null)?.n ?? null;
  };
  return { song: q("SELECT name AS n FROM song_all WHERE id = ?"), version: q("SELECT label AS n FROM version_all WHERE id = ?"), artist: q("SELECT name AS n FROM artist_all WHERE id = ?") };
}

/** The Shared side of a Video as a diff compares against it. */
export const diffNow = (v: ReconcileVideo): DiffNow & { videoTitle: string } => ({
  videoTitle: v.title, title: v.title, type: v.type, songId: v.songId, versionId: v.versionId, artistIds: v.artistIds,
  chapters: v.chapters.map((c) => ({ startS: c.startS, title: c.title, songId: c.songId, versionId: c.versionId })),
});

/**
 * What a plan shelves, per Video, as red/green rows (#157): the local value against the batch's Shared value. Names
 * come from the batch first (a fresh machine holds none of the Shared rows yet), then from the Local copy.
 */
export function planDiffs(db: Db, plan: ReconcilePlan, batch: SharedChanges): VideoDiff[] {
  if (!plan.shelve.length) return [];
  const t = batch.tables ?? {};
  const songs = new Map<string, string>();
  const versions = new Map<string, string>();
  const artists = new Map<string, string>();
  for (const r of t.songs ?? []) songs.set(String(r.id), String(r.name ?? r.slug ?? r.id));
  for (const r of t.video_proposed_songs ?? []) songs.set(r.id, r.name);
  for (const r of t.song_lyrics ?? []) versions.set(String(r.id), String(r.version_label ?? r.label ?? "Complete"));
  for (const r of t.video_proposed_versions ?? []) versions.set(r.id, r.label);
  for (const r of t.artists ?? []) artists.set(String(r.id), String(r.name ?? r.id));
  for (const r of t.video_proposed_artists ?? []) artists.set(r.id, r.name);
  const shared = new Map(sharedVideos(batch).map((v) => [v.id, v]));
  const names = mapNames({ songs, versions, artists }, localNames(db));
  return videoDiffs(plan.shelve.map((s) => ({ videoId: s.videoId, value: s.payload })), (id) => {
    const v = shared.get(id);
    return v ? diffNow(v) : null;
  }, names);
}

// ---------------------------------------------------------------------------------------------------------------
// The SQL half
// ---------------------------------------------------------------------------------------------------------------

/** The guard's floor: a matched Video stamped with it loses to the Shared row the apply brings (Shared wins). */
const EPOCH = "1970-01-01T00:00:00.000Z";
/** Link data replaced wholesale by the Shared Video's (shelved first). */
const LINK_CHILDREN = ["video_chapters", "video_artists", "video_chapter_rejections", "video_artist_rejections"];

/** Every (table, column) that points at `videos(id)`, the link children excepted. */
function videoRefs(db: Db): { table: string; column: string }[] {
  const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name);
  const out: { table: string; column: string }[] = [];
  for (const t of tables) {
    if (LINK_CHILDREN.includes(t)) continue;
    for (const fk of db.query(`SELECT "table" AS parent, "from" AS col FROM pragma_foreign_key_list(?)`).all(t) as { parent: string; col: string }[]) {
      if (fk.parent === "videos") out.push({ table: t, column: fk.col });
    }
  }
  return out;
}

export interface ApplyPlanOptions {
  /** Queue unknown Videos to be shared (a Video Editor at sign-in). */
  queueUnknown?: boolean;
  /** Keep the thumbnail columns of a re-keyed Video (the caller renames its files after the commit); else they are
   * cleared so the Thumbnailer makes them again under the new id. */
  keepThumbnails?: boolean;
  at?: string;
}

export interface AppliedPlan {
  counts: ReconcileCounts;
  /** Local ids that became a Shared id (thumbnail files to rename after the commit). */
  rekeyed: { from: string; to: string }[];
}

/**
 * Carries a plan out. Must run inside the caller's transaction, followed by `applyShared` of the same batch in it:
 * the matched Videos are left stamped with the epoch and holding the Shared identity, and the moved stars point at
 * Shared Chapters only that apply inserts (foreign keys are deferred to the commit).
 */
export function applyPlan(db: Db, plan: ReconcilePlan, opts: ApplyPlanOptions = {}): AppliedPlan {
  const counts = planCounts(plan, opts.queueUnknown === true);
  const rekeyed: { from: string; to: string }[] = [];
  if (!plan.matches.length) {
    if (opts.queueUnknown) for (const id of plan.unknown) setPendingShare(db, id, true);
    return { counts, rekeyed };
  }
  db.exec("PRAGMA defer_foreign_keys = ON");
  const at = opts.at ?? new Date().toISOString();
  const refs = videoRefs(db);
  const goneChapters: string[] = [];
  // Free the unique keys first: two local Videos may hold the keys of one Shared Video between them.
  const free = db.prepare("UPDATE videos SET youtube_id = NULL, content_hash = 'reconcile:' || id WHERE id = ?");
  for (const m of plan.matches) free.run(m.localId);
  const groups = new Map<string, string[]>();
  for (const m of plan.matches) (groups.get(m.sharedId) ?? groups.set(m.sharedId, []).get(m.sharedId)!).push(m.localId);
  const exists = db.prepare("SELECT 1 FROM videos WHERE id = ?");
  for (const [sharedId, localIds] of groups) {
    for (const id of localIds) {
      for (const c of db.query("SELECT id FROM video_chapters WHERE video_id = ?").all(id) as { id: string }[]) goneChapters.push(c.id);
      for (const t of LINK_CHILDREN) db.query(`DELETE FROM ${t} WHERE video_id = ?`).run(id);
    }
    // The kept Video: the one already under the Shared id, else the strongest match.
    const order = localIds.includes(sharedId) ? [sharedId, ...localIds.filter((i) => i !== sharedId)] : localIds;
    for (const id of order) {
      if (id === sharedId) continue;
      if (!exists.get(sharedId)) {
        db.query("UPDATE videos SET id = ? WHERE id = ?").run(sharedId, id);
        for (const r of refs) db.query(`UPDATE ${r.table} SET ${r.column} = ? WHERE ${r.column} = ?`).run(sharedId, id);
        rekeyed.push({ from: id, to: sharedId });
        if (!opts.keepThumbnails) {
          db.query(`UPDATE video_local SET thumbnail_generated_at = NULL, strip_frames = NULL, strip_columns = NULL, strip_rows = NULL,
            strip_frame_w = NULL, strip_frame_h = NULL, poster_hash = NULL WHERE video_id = ?`).run(sharedId);
        }
        continue;
      }
      // A second local Video of the same Shared Video: its rows join the kept one (its Copies become more Copies).
      db.query(`UPDATE video_local SET favorited_at = COALESCE(favorited_at, (SELECT favorited_at FROM video_local WHERE video_id = ?)),
          view_count = view_count + COALESCE((SELECT view_count FROM video_local WHERE video_id = ?), 0) WHERE video_id = ?`).run(id, id, sharedId);
      for (const r of refs) {
        db.query(`UPDATE OR IGNORE ${r.table} SET ${r.column} = ? WHERE ${r.column} = ?`).run(sharedId, id);
        db.query(`DELETE FROM ${r.table} WHERE ${r.column} = ?`).run(id);
      }
      db.query("DELETE FROM videos WHERE id = ?").run(id);
    }
    db.query("UPDATE videos SET updated_at = ? WHERE id = ?").run(EPOCH, sharedId);
  }
  for (const s of plan.shelve) shelve(db, s.videoId, s.payload, at);
  const star = db.prepare("INSERT INTO chapter_local (chapter_id, favorited_at) VALUES (?, ?) ON CONFLICT(chapter_id) DO UPDATE SET favorited_at = excluded.favorited_at");
  for (const s of plan.stars) star.run(s.chapterId, s.favoritedAt);
  if (opts.queueUnknown) for (const id of plan.unknown) setPendingShare(db, id, true);
  // The old ids leave the search index; the apply indexes the Shared rows.
  for (const m of plan.matches) if (m.localId !== m.sharedId) reindexVideo(db, m.localId);
  for (const c of goneChapters) reindexChapter(db, c);
  return { counts, rekeyed };
}

/**
 * The Sync's step (§2.3's clash case): reconciles the local Videos this batch's Shared Videos match, inside the
 * Sync's transaction and before its `applyShared`. Nothing is queued; nothing happens when nothing matches.
 */
export function reconcileBatch(db: Db, batch: SharedChanges): ReconcileCounts {
  const plan = planFor(db, batch);
  if (!plan.matches.length) return planCounts({ ...plan, unknown: [] }, false);
  return applyPlan(db, { ...plan, unknown: [] }).counts;
}

/** Renames a re-keyed Video's thumbnail files (`<id>.poster.webp`, `<id>.strip.webp`); never overwrites. */
export function renameThumbnails(thumbsDir: string, rekeyed: { from: string; to: string }[]) {
  for (const r of rekeyed) {
    for (const kind of ["poster", "strip"]) {
      const from = join(thumbsDir, `${r.from}.${kind}.webp`);
      const to = join(thumbsDir, `${r.to}.${kind}.webp`);
      try {
        if (existsSync(from) && !existsSync(to)) renameSync(from, to);
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The routes' jobs
// ---------------------------------------------------------------------------------------------------------------

export interface ReconcileOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  thumbsDir?: string;
}

/** A preview's pull is reused by the Continue that follows it within this long (same account). */
export const PREVIEW_REUSE_MS = 10 * 60 * 1000;

const isWhoami = (w: unknown): w is VideoWhoami =>
  !!w && typeof w === "object" && typeof (w as VideoWhoami).user_id === "string" && typeof (w as VideoWhoami).shared_schema === "number";
const refusal = (r: Extract<ArchiveCall<unknown>, { ok: false }>, what: string) => `The archive refused ${what} (${r.error.code ?? r.error.word})`;

export function createReconcile(db: Db, endpoint: ArchiveEndpoint, opts: ReconcileOptions = {}) {
  const now = opts.now ?? Date.now;
  let held: { userId: string; at: number; batch: SharedChanges } | null = null;
  const fail = (error: string, o: Partial<ReconcileResponse> = {}): ReconcileResponse => ({ ok: false, error, record: readSessionRecord(db), mustChangePassword: false, counts: NO_RECONCILE, diffs: [], ...o });

  /** whoami (the record), the schema gate, the grant; then the Shared set, pulled whole or reused. */
  async function prepare(token: string, reuse: boolean) {
    const exp = tokenExp(token);
    if (exp != null && exp * 1000 <= now()) return { done: fail("The session's access token has expired") };
    const c: RpcClient = postgrestClient(endpoint, token, opts.fetchImpl);
    const r = await whoami(c);
    if (!r.ok) return { done: fail(r.unreachable ? "The archive can't be reached" : refusal(r, "the sign-in")) };
    if (!isWhoami(r.value)) return { done: fail("The archive's video_whoami() answered in an unknown shape") };
    const w = r.value;
    const record: SessionRecord = writeSessionRecord(db, {
      userId: w.user_id, email: w.email ?? null, displayName: w.display_name ?? null, avatarUrl: w.avatar_url ?? null,
      grantLevel: w.grant_level === "editor" || w.grant_level === "member" ? w.grant_level : null,
      archiveRole: w.archive_role ?? null, lastVerifiedAt: w.server_time ?? new Date(now()).toISOString(),
    });
    const mustChangePassword = w.must_change_password === true;
    const gate = schemaGateLine(SHARED_SCHEMA, w.shared_schema);
    if (gate) return { done: fail(gate, { record, mustChangePassword }) };
    // No grant: nothing to pull, nothing to reconcile; the library stays as it is, read-only (§5.1).
    if (!record.grantLevel) return { done: { ok: true, error: null, record, mustChangePassword, counts: NO_RECONCILE, diffs: [] } as ReconcileResponse };
    if (reuse && held && held.userId === record.userId && now() - held.at < PREVIEW_REUSE_MS) return { record, mustChangePassword, batch: held.batch };
    const pull = await changesSince(c, null);
    if (!pull.ok) return { done: fail(pull.unreachable ? "The archive can't be reached" : refusal(pull, "the pull"), { record, mustChangePassword }) };
    const batch = pull.value as SharedChanges | null;
    if (!batch || typeof batch !== "object") return { done: fail("The archive's shared_changes_since() answered in an unknown shape", { record, mustChangePassword }) };
    if (batch.shared_schema != null && batch.shared_schema !== SHARED_SCHEMA) return { done: fail(schemaGateLine(SHARED_SCHEMA, batch.shared_schema) ?? "Shared schema mismatch", { record, mustChangePassword }) };
    held = { userId: record.userId, at: now(), batch };
    return { record, mustChangePassword, batch };
  }

  return {
    /** `GET /api/reconcile/preview`: what Continue would do. Writes the record; changes nothing else. */
    async preview(token: string): Promise<ReconcileResponse> {
      const p = await prepare(token, false);
      if ("done" in p) return p.done!;
      const editor = p.record.grantLevel === "editor";
      const plan = planFor(db, p.batch);
      return { ok: true, error: null, record: p.record, mustChangePassword: p.mustChangePassword, counts: planCounts(plan, editor), diffs: planDiffs(db, plan, p.batch) };
    },
    /** `POST /api/reconcile`: reconciles and applies the Shared set in one transaction. The Sync that follows pulls. */
    async confirm(token: string): Promise<ReconcileResponse> {
      const p = await prepare(token, true);
      if ("done" in p) return p.done!;
      const editor = p.record.grantLevel === "editor";
      let done: AppliedPlan;
      let diffs: VideoDiff[] = [];
      try {
        done = db.transaction(() => {
          // A Member's unknown Videos stay Unshared, queued ones from an earlier editor session included (§2.5).
          if (!editor) loseEditorGrant(db);
          const plan = planFor(db, p.batch);
          // Read before the apply: the local values and the local_* names they point at are still where they were.
          diffs = planDiffs(db, plan, p.batch);
          const r = applyPlan(db, plan, { queueUnknown: editor, keepThumbnails: !!opts.thumbsDir });
          applyShared(db, p.batch);
          return r;
        })();
      } catch (e) {
        return fail(`Reconciliation failed, nothing was changed: ${(e as Error)?.message ?? e}`, { record: p.record, mustChangePassword: p.mustChangePassword });
      }
      held = null;
      if (opts.thumbsDir) renameThumbnails(opts.thumbsDir, done.rekeyed);
      return { ok: true, error: null, record: readSessionRecord(db), mustChangePassword: p.mustChangePassword, counts: done.counts, diffs };
    },
  };
}

export type ReconcileRunner = ReturnType<typeof createReconcile>;
