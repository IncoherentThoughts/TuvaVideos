// Local Songs and Local Versions (the Song-side counterpart of a Local Artist and a Local Studio track): created,
// edited and deleted here, never exported, and kept outside the mirror_* tables so an import leaves them alone.
// Readers (songs.ts, search.ts, edit.ts, ...) see them through the song_all / version_all views.
import type { Db } from "./db";
import { indexSong, indexVersion, reindexVideo } from "./search";
import { fillLatinTitles } from "./latin";
import { SCRIPTS, parseFootnotes } from "../shared/lyrics/scripts";
import { sanitizeFootnoteHtml, sanitizeLine } from "../shared/lyrics/sanitize";
import { DEFAULT_VERSION_LABEL } from "../shared/lyrics/trackVersion";
import type { ScriptKey, VersionInput } from "../shared/lyrics/types";

export type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string };
const bad = (error: string, status = 400): { ok: false; status: number; error: string } => ({ ok: false, status, error });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

const cleanName = (raw: unknown, what: string, max = 200): Result<string> => {
  const t = typeof raw === "string" ? raw.trim().replace(/\s+/g, " ") : "";
  if (!t) return bad(`${what} must be a non-empty string`);
  if (t.length > max) return bad(`${what} is too long`);
  return ok(t);
};
const optName = (raw: unknown, what: string): Result<string | null> => {
  if (raw === undefined || raw === null) return ok(null);
  if (typeof raw !== "string") return bad(`${what} must be a string or null`);
  const t = raw.trim().replace(/\s+/g, " ");
  if (t.length > 200) return bad(`${what} is too long`);
  return ok(t || null);
};

export interface LocalSongRow { id: string; name: string; english_name: string | null }

/** Creates a Local Song. A Song (Mirror or Local) already named so, case-insensitively, is returned instead. */
export function createLocalSong(db: Db, body: Record<string, unknown>): Result<{ id: string; name: string; englishName: string | null; local: boolean; created: boolean }> {
  const name = cleanName(body.name, "name");
  if (!name.ok) return name;
  const en = optName(body.englishName, "englishName");
  if (!en.ok) return en;
  const want = name.value.toLowerCase();
  const same = (db.query("SELECT id, name, english_name, local FROM song_all ORDER BY local, name").all() as (LocalSongRow & { local: number })[]).find((s) => s.name.toLowerCase() === want);
  if (same) return ok({ id: same.id, name: same.name, englishName: same.english_name, local: !!same.local, created: false });
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare("INSERT INTO local_song (id, name, english_name, created_at) VALUES (?, ?, ?, ?)").run(id, name.value, en.value, new Date().toISOString());
    indexSong(db, id);
  })();
  return ok({ id, name: name.value, englishName: en.value, local: true, created: true });
}

/** Renames a Local Song (a Mirror Song's name belongs to the archive). */
export function patchLocalSong(db: Db, id: string, body: Record<string, unknown>): Result<{ id: string; name: string; englishName: string | null }> {
  const cur = db.query("SELECT id, name, english_name FROM local_song WHERE id = ?").get(id) as LocalSongRow | null;
  if (!cur) {
    if (db.query("SELECT 1 FROM mirror_song WHERE id = ?").get(id)) return bad("this Song comes from the archive and is edited there", 409);
    return bad("no such Song", 404);
  }
  let name = cur.name;
  let en = cur.english_name;
  if ("name" in body) {
    const r = cleanName(body.name, "name");
    if (!r.ok) return r;
    const want = r.value.toLowerCase();
    const clash = (db.query("SELECT id, name FROM song_all WHERE id != ?").all(id) as LocalSongRow[]).find((s) => s.name.toLowerCase() === want);
    if (clash) return bad(`a Song named ${clash.name} already exists`, 409);
    name = r.value;
  }
  if ("englishName" in body) {
    const r = optName(body.englishName, "englishName");
    if (!r.ok) return r;
    en = r.value;
  }
  db.transaction(() => {
    db.prepare("UPDATE local_song SET name = ?, english_name = ? WHERE id = ?").run(name, en, id);
    indexSong(db, id);
    for (const v of db.query("SELECT id FROM video WHERE song_id = ?").all(id) as { id: number }[]) reindexVideo(db, v.id);
    fillLatinTitles(db);
  })();
  return ok({ id, name, englishName: en });
}

/** Deletes a Local Song and its Local Versions. Refused while a Video, Chapter or Studio track still points at it. */
export function deleteLocalSong(db: Db, id: string): Result<{ deleted: true }> {
  if (!db.query("SELECT 1 FROM local_song WHERE id = ?").get(id)) {
    if (db.query("SELECT 1 FROM mirror_song WHERE id = ?").get(id)) return bad("this Song comes from the archive and cannot be deleted here", 409);
    return bad("no such Song", 404);
  }
  const n = (sql: string) => (db.query(sql).get(id) as { n: number }).n;
  const used = n("SELECT COUNT(*) n FROM video WHERE song_id = ?") + n("SELECT COUNT(*) n FROM chapter WHERE song_id = ?") + n("SELECT COUNT(*) n FROM studio_track WHERE song_id = ?");
  if (used) return bad(`${used} Video${used === 1 ? "" : "s"}, Chapter${used === 1 ? "" : "s"} or Studio track${used === 1 ? "" : "s"} still point at this Song; clear them first`, 409);
  db.transaction(() => {
    for (const v of db.query("SELECT id FROM local_version WHERE song_id = ?").all(id) as { id: string }[]) {
      db.prepare("DELETE FROM local_version WHERE id = ?").run(v.id);
      indexVersion(db, v.id);
    }
    db.prepare("DELETE FROM local_song WHERE id = ?").run(id);
    indexSong(db, id);
  })();
  return ok({ deleted: true });
}

// ---- Versions ----

interface Cols { label?: string; scripts?: Record<string, string | null> }

/** Validates and sanitizes a Version body: `label` and `scripts: {cyrillic: {html, footnotes}, ...}` (any may be left out). */
function readVersionBody(body: Record<string, unknown>, requireLabel: boolean): Result<Cols> {
  const out: Cols = {};
  if ("label" in body || requireLabel) {
    const r = cleanName(body.label ?? (requireLabel ? DEFAULT_VERSION_LABEL : undefined), "label", 80);
    if (!r.ok) return r;
    out.label = r.value;
  }
  if ("scripts" in body) {
    const s = body.scripts as Partial<VersionInput["scripts"]> | null;
    if (!s || typeof s !== "object") return bad("scripts must be an object");
    out.scripts = {};
    for (const def of SCRIPTS) {
      const sc = s[def.key as ScriptKey];
      if (sc === undefined) continue;
      if (sc === null) {
        out.scripts[def.column] = null;
        out.scripts[def.footnoteColumn] = "[]";
        continue;
      }
      if (typeof sc !== "object" || (sc.html !== null && typeof sc.html !== "string")) return bad(`scripts.${def.key}.html must be a string or null`);
      if (sc.html && sc.html.length > 200_000) return bad(`scripts.${def.key} is too long`);
      const html = sc.html ? sanitizeLine(sc.html) : "";
      out.scripts[def.column] = html.trim() ? html : null;
      const fns = parseFootnotes(sc.footnotes ?? []).map((f) => ({ id: f.id, text: sanitizeFootnoteHtml(f.text) }));
      out.scripts[def.footnoteColumn] = JSON.stringify(fns);
    }
  }
  return ok(out);
}

export function createLocalVersion(db: Db, songId: string, body: Record<string, unknown>): Result<{ id: string }> {
  if (!db.query("SELECT 1 FROM song_all WHERE id = ?").get(songId)) return bad("no such Song", 404);
  const r = readVersionBody(body, true);
  if (!r.ok) return r;
  const label = r.value.label!;
  const clash = (db.query("SELECT label FROM version_all WHERE song_id = ?").all(songId) as { label: string }[]).find((v) => v.label.toLowerCase() === label.toLowerCase());
  if (clash) return bad(`this Song already has a Version labelled ${clash.label}`, 409);
  const order = ((db.query("SELECT MAX(display_order) m FROM version_all WHERE song_id = ?").get(songId) as { m: number | null }).m ?? 0) + 1;
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const sc = r.value.scripts ?? {};
  db.transaction(() => {
    db.prepare(
      `INSERT INTO local_version (id, song_id, label, display_order, cyrillic, transliteration, translation,
         footnotes_cyrillic, footnotes_transliteration, footnotes_translation, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, songId, label, order, sc.cyrillic ?? null, sc.transliteration ?? null, sc.translation ?? null, sc.footnotes_cyrillic ?? "[]", sc.footnotes_transliteration ?? "[]", sc.footnotes_translation ?? "[]", now, now);
    indexVersion(db, id);
  })();
  return ok({ id });
}

export function patchLocalVersion(db: Db, id: string, body: Record<string, unknown>): Result<{ id: string }> {
  const cur = db.query("SELECT id, song_id, label FROM local_version WHERE id = ?").get(id) as { id: string; song_id: string; label: string } | null;
  if (!cur) {
    if (db.query("SELECT 1 FROM mirror_version WHERE id = ?").get(id)) return bad("this Version comes from the archive; add a local Version instead", 409);
    return bad("no such Version", 404);
  }
  const r = readVersionBody(body, false);
  if (!r.ok) return r;
  const cols = new Map<string, string | null>();
  if (r.value.label !== undefined && r.value.label !== cur.label) {
    const clash = (db.query("SELECT label FROM version_all WHERE song_id = ? AND id != ?").all(cur.song_id, id) as { label: string }[]).find((v) => v.label.toLowerCase() === r.value.label!.toLowerCase());
    if (clash) return bad(`this Song already has a Version labelled ${clash.label}`, 409);
    cols.set("label", r.value.label);
  }
  for (const [k, v] of Object.entries(r.value.scripts ?? {})) cols.set(k, v);
  if (!cols.size) return ok({ id });
  cols.set("updated_at", new Date().toISOString());
  db.transaction(() => {
    db.prepare(`UPDATE local_version SET ${[...cols.keys()].map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.values(), id);
    indexVersion(db, id);
  })();
  return ok({ id });
}

/** Deletes a Local Version; Videos and Chapters pointing at it fall back to the Song's default Version. */
export function deleteLocalVersion(db: Db, id: string): Result<{ deleted: true }> {
  if (!db.query("SELECT 1 FROM local_version WHERE id = ?").get(id)) {
    if (db.query("SELECT 1 FROM mirror_version WHERE id = ?").get(id)) return bad("this Version comes from the archive and cannot be deleted here", 409);
    return bad("no such Version", 404);
  }
  db.transaction(() => {
    db.prepare("UPDATE video SET version_id = NULL WHERE version_id = ?").run(id);
    db.prepare("UPDATE chapter SET version_id = NULL WHERE version_id = ?").run(id);
    db.prepare("DELETE FROM local_version WHERE id = ?").run(id);
    indexVersion(db, id);
  })();
  return ok({ deleted: true });
}
