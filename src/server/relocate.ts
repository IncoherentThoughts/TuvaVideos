// Relocate a Copy (Now playing's folder button): point an existing Video at its file's new place on disk, keeping every
// edit, tag, Chapter and Favorite. The new path must lie inside a Root (a Copy is always Root + path inside it).
// When a scan already took the moved file in as a separate Video (its name lost the [id], or the bytes changed), the
// caller must ask to merge: that file's Copy joins this Video, and the stray Video is removed once it has no Copy left.
import { realpath, unlink, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Config } from "./config";
import type { Db } from "./db";
import type { EditResult } from "./edit";
import { containerFor, parseFilename } from "./filename";
import { decidePlayback } from "./playback";
import { probeFile } from "./probe";
import type { RootRow } from "./roots";
import { judgeStaleCopies } from "./tvJudge";

export interface RelocateBody {
  path: string;
  /** The Copy to move; default: the Video's first missing Copy, else its only Copy. */
  copyId?: number | null;
  /** Take over a Copy that another Video already owns at that path. */
  merge?: boolean;
}

export type RelocateResult =
  | EditResult<{ copyId: number; rootId: number }>
  | { ok: false; status: 409; error: string; conflict: { videoId: string; title: string } };

const bad = (error: string, status = 400) => ({ ok: false as const, status, error });

/** The Root whose folder holds `abs` (the deepest one when Roots nest). */
export function rootFor(roots: RootRow[], abs: string): RootRow | null {
  let best: RootRow | null = null;
  for (const r of roots) {
    const base = resolve(r.path);
    if ((abs === base || abs.startsWith(base.endsWith(sep) ? base : base + sep)) && (!best || base.length > resolve(best.path).length)) best = r;
  }
  return best;
}

/**
 * Remove a Video that has no Copy left, with every row that hangs off it (ON DELETE CASCADE). A Shared Video stays:
 * its link data is the Shared data's, and with no Copy it is simply Not on this machine (sharing-spec §7.1).
 */
function dropVideo(db: Db, id: string) {
  if ((db.query("SELECT shared FROM video_full WHERE id = ?").get(id) as { shared: number } | null)?.shared) return;
  for (const c of db.query("SELECT id FROM video_chapters WHERE video_id = ?").all(id) as { id: string }[])
    db.query("DELETE FROM search WHERE kind = 'chapter' AND ref_id = ?").run(c.id);
  db.query("DELETE FROM search WHERE kind = 'video' AND ref_id = ?").run(id);
  db.query("DELETE FROM videos WHERE id = ?").run(id);
}

/**
 * Delete a superseded Copy row of `videoId`, handing its thumbnail pointer to the Copy that replaces it. Its Fallback's
 * name goes to `orphans`, for the caller to unlink once the transaction is done (audit PLAY-9).
 */
function dropCopy(db: Db, videoId: string, oldId: number, newId: number, orphans: string[]) {
  const fb = (db.query("SELECT fallback_file FROM copy WHERE id = ?").get(oldId) as { fallback_file: string | null } | null)?.fallback_file;
  if (fb) orphans.push(fb);
  db.query("UPDATE video_local SET thumbnail_copy_id = ? WHERE video_id = ? AND thumbnail_copy_id = ?").run(newId, videoId, oldId);
  db.query("DELETE FROM copy WHERE id = ?").run(oldId);
}

const unlinkFallbacks = (cfg: Pick<Config, "remuxDir">, names: string[]) => Promise.all(names.map((n) => unlink(resolve(cfg.remuxDir, n)).catch(() => {})));

/**
 * The Copy row at `rel` in a Root: the exact spelling first, else one recorded under another Unicode normalization of
 * it (a file picker and a directory listing may disagree; audit DB-2).
 */
function copyAt(db: Db, rootId: number, rel: string) {
  const sql = "SELECT c.id, c.video_id, v.title, c.rel_path FROM copy c JOIN videos v ON v.id = c.video_id WHERE c.root_id = ?";
  type Row = { id: number; video_id: string; title: string; rel_path: string };
  const exact = db.query(`${sql} AND c.rel_path = ?`).get(rootId, rel) as Row | null;
  if (exact) return exact;
  const key = rel.normalize("NFC");
  return (db.query(sql).all(rootId) as Row[]).find((r) => r.rel_path.normalize("NFC") === key) ?? null;
}

export async function relocateCopy(db: Db, cfg: Pick<Config, "ffprobe" | "remuxDir">, roots: RootRow[], videoId: string, body: RelocateBody): Promise<RelocateResult> {
  if (!db.query("SELECT 1 FROM video_full WHERE id = ?").get(videoId)) return bad("no such video", 404);
  if (typeof body.path !== "string" || !body.path.trim()) return bad("path must be the file's full path");
  const raw = body.path.trim().replace(/^~(?=\/)/, process.env.HOME ?? "~");
  if (!isAbsolute(raw)) return bad("path must be a full path (starting with /)");
  const abs = resolve(raw);

  const copies = db.query("SELECT id, missing_since, fallback_file FROM copy WHERE video_id = ? ORDER BY id").all(videoId) as { id: number; missing_since: string | null; fallback_file: string | null }[];
  const target =
    body.copyId != null ? copies.find((c) => c.id === body.copyId) : copies.find((c) => c.missing_since) ?? (copies.length === 1 ? copies[0] : undefined);
  if (body.copyId != null && !target) return bad("that Copy is not this Video's", 404);
  if (!target && copies.length > 1) return bad("this Video has several Copies: say which one moved (copyId)");

  const st = await stat(abs).catch(() => null);
  if (!st) return bad(`no file at ${abs}`, 404);
  if (!st.isFile()) return bad("that path is a folder, not a video file");
  if (parseFilename(basename(abs)).skip) return bad("that is not a video file (mp4, mkv, webm, mov or m4v)");
  let root = rootFor(roots, abs);
  let inRoot = abs;
  if (!root) {
    // A Root, or the given path, reached through a symlink or spelled in another case (audit DB-13): compare the
    // canonical paths, and express the file under the Root's recorded path.
    const real = await realpath(abs).catch(() => abs);
    const canon = await Promise.all(roots.map(async (r) => ({ ...r, path: await realpath(r.path).catch(() => r.path) })));
    const hit = rootFor(canon, real);
    if (hit) {
      root = roots.find((r) => r.id === hit.id)!;
      inRoot = join(root.path, relative(resolve(hit.path), real));
    }
  }
  if (!root) return bad(`that file is outside the library folders (${roots.map((r) => r.path).join(", ")}); move it into one of them first`);
  // The spelling as given, which is what opens the file on a byte-comparing filesystem (audit DB-2).
  const rel = relative(resolve(root.path), inRoot);
  const orphans: string[] = [];

  const dest = copyAt(db, root.id, rel);
  if (dest && dest.video_id === videoId) {
    // A scan already found the moved file for this Video: the stale row just goes.
    if (target && target.id !== dest.id) db.transaction(() => dropCopy(db, videoId, target.id, dest.id, orphans))();
    db.query("UPDATE copy SET missing_since = NULL, rel_path = ? WHERE id = ?").run(rel, dest.id);
    await unlinkFallbacks(cfg, orphans);
    return { ok: true, value: { copyId: dest.id, rootId: root.id } };
  }
  if (dest) {
    if (!body.merge) return { ok: false, status: 409, error: `that file is already the separate Video “${dest.title}”`, conflict: { videoId: dest.video_id, title: dest.title } };
    db.transaction(() => {
      db.query("UPDATE copy SET video_id = ?, missing_since = NULL WHERE id = ?").run(videoId, dest.id);
      if (target) dropCopy(db, videoId, target.id, dest.id, orphans);
      if (!db.query("SELECT 1 FROM copy WHERE video_id = ?").get(dest.video_id)) dropVideo(db, dest.video_id);
    })();
    await unlinkFallbacks(cfg, orphans);
    return { ok: true, value: { copyId: dest.id, rootId: root.id } };
  }

  const probe = await probeFile(cfg, abs);
  if (!probe.ok) return bad(`could not read that file: ${probe.error}`, probe.io ? 503 : 400);
  const f = probe.facts;
  if (!f.hasVideo) return bad("that file has no video stream");
  const facts = [st.size, new Date(st.mtimeMs).toISOString(), f.duration, containerFor(parseFilename(basename(abs)).ext), f.videoCodec, f.audioCodec, f.width, f.height, f.rFrameRate, decidePlayback(f)] as const;
  if (target) {
    if (target.fallback_file) await unlink(resolve(cfg.remuxDir, target.fallback_file)).catch(() => {});
    db.query(
      `UPDATE copy SET root_id = ?, rel_path = ?, size = ?, mtime = ?, duration_s = ?, container = ?, video_codec = ?, audio_codec = ?, width = ?, height = ?,
         r_frame_rate = ?, playback = ?, tv_playback = NULL, tv_profile_version = NULL, fallback_file = NULL, keyframes = NULL, content_hash = NULL, missing_since = NULL WHERE id = ?`,
    ).run(root.id, rel, ...facts, target.id);
    judgeStaleCopies(db);
    return { ok: true, value: { copyId: target.id, rootId: root.id } };
  }
  const id = Number(
    db.query(
      `INSERT INTO copy (video_id, root_id, rel_path, size, mtime, duration_s, container, video_codec, audio_codec, width, height, r_frame_rate, playback)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(videoId, root.id, rel, ...facts).lastInsertRowid,
  );
  judgeStaleCopies(db);
  return { ok: true, value: { copyId: id, rootId: root.id } };
}
