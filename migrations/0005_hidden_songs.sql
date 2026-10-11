-- 0005: hidden Songs are imported too (the research doc's recommendation, asked for after the v1 build): they carry a
-- third of the Performance YouTube ids. `is_hidden` is shown as a badge; nothing else treats them differently.
ALTER TABLE mirror_song ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0;
