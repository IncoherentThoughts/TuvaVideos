-- 0020: the touch triggers stay out of `applyShared` (docs/audit/02-sync-shared-data.md SYNC-2). They stamp a local
-- edit of a Shared table "unless the statement set `updated_at`", but they cannot tell "did not set it" from "set it to
-- the value it already had": the apply re-upserts a bumped Video's unchanged children with the stamp they already hold,
-- the trigger fired, and each such Chapter got this machine's clock instead of the archive's stamp, so its next edit
-- sent a stale `p_expected_updated_at` and hit a false conflict. The apply now holds the `meta` row
-- `applying_shared` for the length of its transaction, and the triggers do nothing while it is there.

DROP TRIGGER IF EXISTS videos_touch;
DROP TRIGGER IF EXISTS video_chapters_touch;
DROP TRIGGER IF EXISTS video_artists_touch;

CREATE TRIGGER videos_touch AFTER UPDATE ON videos
WHEN NEW.updated_at IS OLD.updated_at AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'applying_shared')
BEGIN UPDATE videos SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER video_chapters_touch AFTER UPDATE ON video_chapters
WHEN NEW.updated_at IS OLD.updated_at AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'applying_shared')
BEGIN UPDATE video_chapters SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;
CREATE TRIGGER video_artists_touch AFTER UPDATE ON video_artists
WHEN NEW.updated_at IS OLD.updated_at AND NOT EXISTS (SELECT 1 FROM meta WHERE key = 'applying_shared')
BEGIN UPDATE video_artists SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id; END;

-- A row left by an apply that never committed cannot exist (the row is written inside the apply's transaction), but a
-- stray one would silence every local stamp: clear it.
DELETE FROM meta WHERE key = 'applying_shared';
