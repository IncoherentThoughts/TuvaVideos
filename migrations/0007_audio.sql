-- 0007: Audio settings (spec 4.7). What the Player does to a Video's sound (channel routing, balance, EQ, leveler)
-- persists per Video, so a badly mixed recording is fixed once. Custom EQ presets are shared across Videos.
-- The settings row is JSON (src/shared/audio.ts normalizes it on the way in and out): the shape will grow with the
-- panel, and nothing queries inside it.
CREATE TABLE video_audio (
  video_id INTEGER PRIMARY KEY REFERENCES video(id),
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE audio_preset (
  name TEXT PRIMARY KEY,
  eq TEXT NOT NULL,                        -- JSON array of seven band gains in dB
  created_at TEXT NOT NULL
);
