// The machine facts of the Local copy (docs/sharing-spec.md §2.1, §5.2, §6.1, §6.4, §6.6): the Shared schema version,
// the token-free Session record, the watermark, Shelved edits and the `pending_share` queue. SQL only; the routes that
// expose them belong to the sign-in, Sync and write-model tickets (#114, #115, #116).
import type { Db } from "../db";

/**
 * The Shared schema this checkout speaks (§6.4's schema gate compares it with `video_whoami().shared_schema`). A
 * migration that reshapes a Shared table bumps the `meta` row in the same SQL file and this constant with it.
 */
export const SHARED_SCHEMA = 1;

/** The `shared_schema` the Local copy's migrations recorded. */
export function localSharedSchema(db: Db): number {
  const r = db.query("SELECT value FROM meta WHERE key = 'shared_schema'").get() as { value: string } | null;
  return r ? Number(r.value) : 0;
}

export function getMeta(db: Db, key: string): string | null {
  return (db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
}

export function setMeta(db: Db, key: string, value: string | null) {
  if (value == null) db.query("DELETE FROM meta WHERE key = ?").run(key);
  else db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}

// ---------------------------------------------------------------------------------------------------------------
// The Session record (§5.2)
// ---------------------------------------------------------------------------------------------------------------

// The record's type lives in src/shared/session.ts so the browser's session layer reads the same shape.
import type { GrantLevel, SessionRecord } from "../../shared/session";
export type { GrantLevel, SessionRecord };

/** The machine's mode (§2.1): no record, a record without the grant, or a Member / Video Editor. */
export type MachineMode = "standalone" | "no-grant" | GrantLevel;

export function readSessionRecord(db: Db): SessionRecord | null {
  const r = db.query("SELECT * FROM session_record WHERE id = 1").get() as Record<string, string | null> | null;
  if (!r) return null;
  return {
    userId: r.user_id!, email: r.email, displayName: r.display_name, avatarUrl: r.avatar_url, grantLevel: r.grant_level as GrantLevel | null,
    archiveRole: r.archive_role, lastVerifiedAt: r.last_verified_at, lastSyncAt: r.last_sync_at, watermark: r.watermark,
  };
}

/** Writes the record; fields left out keep their held value (a new user id starts a fresh record). */
export function writeSessionRecord(db: Db, rec: Partial<SessionRecord> & { userId: string }): SessionRecord {
  const cur = readSessionRecord(db);
  const base: SessionRecord =
    cur && cur.userId === rec.userId
      ? cur
      : { userId: rec.userId, email: null, displayName: null, avatarUrl: null, grantLevel: null, archiveRole: null, lastVerifiedAt: null, lastSyncAt: null, watermark: null };
  const next: SessionRecord = { ...base, ...Object.fromEntries(Object.entries(rec).filter(([, v]) => v !== undefined)) } as SessionRecord;
  db.query(
    `INSERT INTO session_record (id, user_id, email, display_name, avatar_url, grant_level, archive_role, last_verified_at, last_sync_at, watermark)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET user_id = excluded.user_id, email = excluded.email, display_name = excluded.display_name,
       avatar_url = excluded.avatar_url, grant_level = excluded.grant_level, archive_role = excluded.archive_role,
       last_verified_at = excluded.last_verified_at, last_sync_at = excluded.last_sync_at, watermark = excluded.watermark`,
  ).run(next.userId, next.email, next.displayName, next.avatarUrl, next.grantLevel, next.archiveRole, next.lastVerifiedAt, next.lastSyncAt, next.watermark);
  return next;
}

/** Sign out, a SIGNED_OUT event or a cancelled reconciliation (§2.4, §5.4). The Local copy stays, read-only. */
export function clearSessionRecord(db: Db) {
  db.query("DELETE FROM session_record").run();
}

export function machineMode(rec: SessionRecord | null): MachineMode {
  if (!rec) return "standalone";
  return rec.grantLevel ?? "no-grant";
}

// ---------------------------------------------------------------------------------------------------------------
// Shelved edits (§2.3, §7.4)
// ---------------------------------------------------------------------------------------------------------------

export type ShelvedKind = "title" | "type" | "song" | "artists" | "chapter";

/** What a Shelved edit keeps: the values the local row had before the Shared row replaced it. */
export type ShelvedPayload =
  | { kind: "title"; title: string; titleLatin: string | null }
  | { kind: "type"; type: string }
  | { kind: "song"; songId: string | null; versionId: string | null }
  | { kind: "artists"; artistIds: string[] }
  | { kind: "chapter"; startS: number; title: string; songId: string | null; versionId: string | null; favoritedAt: string | null };

export interface ShelvedEdit {
  id: number;
  videoId: string;
  payload: ShelvedPayload;
  shelvedAt: string;
}

export function shelve(db: Db, videoId: string, payload: ShelvedPayload, at = new Date().toISOString()): number {
  return Number(db.query("INSERT INTO shelved_edit (video_id, kind, payload, shelved_at) VALUES (?, ?, ?, ?)").run(videoId, payload.kind, JSON.stringify(payload), at).lastInsertRowid);
}

export function listShelved(db: Db, videoId?: string): ShelvedEdit[] {
  const rows = (videoId
    ? db.query("SELECT * FROM shelved_edit WHERE video_id = ? ORDER BY id").all(videoId)
    : db.query("SELECT * FROM shelved_edit ORDER BY id").all()) as { id: number; video_id: string; payload: string; shelved_at: string }[];
  return rows.map((r) => ({ id: r.id, videoId: r.video_id, payload: JSON.parse(r.payload) as ShelvedPayload, shelvedAt: r.shelved_at }));
}

/** Clears one Video's Shelved edits, or all of them (the chip menu's "Clear Shelved edits"). Returns how many went. */
export function clearShelved(db: Db, videoId?: string): number {
  return (videoId ? db.query("DELETE FROM shelved_edit WHERE video_id = ?").run(videoId) : db.query("DELETE FROM shelved_edit").run()).changes;
}

// ---------------------------------------------------------------------------------------------------------------
// `pending_share` (§6.6)
// ---------------------------------------------------------------------------------------------------------------

/** Videos a Video Editor's scan queued for sharing, oldest first. */
export function pendingShareIds(db: Db): string[] {
  return (db.query("SELECT v.id FROM videos v JOIN video_local l ON l.video_id = v.id WHERE l.pending_share = 1 ORDER BY v.created_at, v.id").all() as { id: string }[]).map((r) => r.id);
}

export function setPendingShare(db: Db, videoId: string, pending: boolean) {
  db.query("INSERT INTO video_local (video_id, pending_share) VALUES (?, ?) ON CONFLICT(video_id) DO UPDATE SET pending_share = excluded.pending_share").run(videoId, pending ? 1 : 0);
}
