// The archive fixture (test/fixtures/backup: the archive's tables as JSON, the same rows `shared_changes_since`
// returns) loaded into a Local copy through applyShared, the way Sync fills it now that the Mirror import is gone.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../../src/server/db";
import { applyShared } from "../../src/server/localCopy/apply";
import type { ApplySharedResult, SharedChanges, SharedTables } from "../../src/shared/sharedRows";

export const FIXTURE = join(import.meta.dir, "..", "fixtures", "backup");
const TABLES = ["songs", "song_lyrics", "artists", "albums", "album_artists", "album_tracks", "album_track_artists", "song_performances"] as const;

/** The archive tables of a backup-shaped directory, as `shared_changes_since(...).tables`. */
export function archiveChanges(dir = FIXTURE): SharedTables {
  const out: SharedTables = {};
  for (const t of TABLES) {
    const f = join(dir, `${t}.json`);
    if (existsSync(f)) out[t] = JSON.parse(readFileSync(f, "utf8"));
  }
  return out;
}

export function loadArchiveFixture(db: Db, dir = FIXTURE): ApplySharedResult {
  return applyShared(db, { tables: archiveChanges(dir) });
}

const TOP = new Set(["tombstones", "replace_whole", "archive_ids", "watermark", "since", "server_time", "shared_schema"]);

/** Tests' shorthand: tables and the batch's own fields in one object, split into the wire's `{tables, ...}` shape. */
export function applyFlat(db: Db, flat: SharedTables & Omit<SharedChanges, "tables">): ApplySharedResult {
  const batch: SharedChanges = { tables: {} };
  for (const [k, v] of Object.entries(flat)) {
    if (TOP.has(k)) (batch as Record<string, unknown>)[k] = v;
    else (batch.tables as Record<string, unknown>)[k] = v;
  }
  return applyShared(db, batch);
}
