-- 0014: the TV Server (docs/tv-spec.md §2, §3.1). approved_tv is the click-to-approve IP allowlist (ADR 0004);
-- copy.tv_playback is the TV Playback profile's decision for the Copy (JSON), copy.tv_profile_version the profile
-- version it was judged under. Null columns are judged from the stored ffprobe facts at the next startup or scan.
CREATE TABLE approved_tv (
  ip TEXT PRIMARY KEY,
  model TEXT,
  approved_at TEXT NOT NULL,
  last_seen_at TEXT
);
ALTER TABLE copy ADD COLUMN tv_playback TEXT;
ALTER TABLE copy ADD COLUMN tv_profile_version INTEGER;
