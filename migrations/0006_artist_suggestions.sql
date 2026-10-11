-- 0006: Suggested Artists (the Artist matcher, spec 2.3). A video_artist row is Suggested until the person confirms
-- it; a rejected suggestion leaves a tombstone so the matcher does not offer it again.
ALTER TABLE video_artist ADD COLUMN suggested INTEGER NOT NULL DEFAULT 0;
CREATE TABLE artist_rejection (
  video_id INTEGER NOT NULL REFERENCES video(id),
  artist_id INTEGER NOT NULL REFERENCES artist(id),
  rejected_at TEXT NOT NULL,
  PRIMARY KEY (video_id, artist_id)
);
