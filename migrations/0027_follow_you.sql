-- 0027: Resume and Favorites follow you through the Home Server (docs/home-server-spec.md §6).
--
-- `resume_at`: when the Resume position was last set (on any machine of the owner's). `favorite_at`: when the Video or
-- Chapter was last starred or unstarred; `favorited_at` null with `favorite_at` set means unstarred, so an unstar wins
-- over an older star. Newest wins between machines by these two.
-- `me_changed_at`: this machine's own clock when the row's Resume or Favorite last changed here (a local write or one
-- applied from another machine). The Home Server answers `GET /api/me/state?since=` by it, so a write that reaches it
-- late (from a Mac's outbox, stamped hours ago) is still handed to the other Macs.
ALTER TABLE video_local ADD COLUMN resume_at TEXT;
ALTER TABLE video_local ADD COLUMN favorite_at TEXT;
ALTER TABLE video_local ADD COLUMN me_changed_at TEXT;
ALTER TABLE chapter_local ADD COLUMN favorite_at TEXT;
ALTER TABLE chapter_local ADD COLUMN me_changed_at TEXT;

UPDATE video_local SET resume_at = last_played_at WHERE resume_s IS NOT NULL;
UPDATE video_local SET favorite_at = favorited_at;
UPDATE video_local SET me_changed_at = CASE WHEN COALESCE(resume_at, '') > COALESCE(favorite_at, '') THEN resume_at ELSE favorite_at END;
UPDATE chapter_local SET favorite_at = favorited_at, me_changed_at = favorited_at;

-- On a Mac with a Home Server: writes not yet delivered to it, sent in order on reconnect (§6.1).
CREATE TABLE home_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('resume', 'favorite')),
  key TEXT NOT NULL,                     -- kind + Video identity (+ Chapter start ms): a later write supersedes an earlier one
  body TEXT NOT NULL,                    -- the PUT /api/me/<kind> body
  created_at TEXT NOT NULL
);

-- On a Mac with a Home Server: the Home Server's Resume and Favorite of its own Videos this Mac does not have
-- (`home_video` rows), by the Video's id there. Kept apart from `home_video`, which each index fetch replaces.
CREATE TABLE home_me (
  video_id TEXT PRIMARY KEY,
  favorited_at TEXT,
  favorite_at TEXT,
  resume_s REAL,
  resume_at TEXT
);
