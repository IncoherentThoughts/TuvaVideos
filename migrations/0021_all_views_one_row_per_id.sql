-- 0021: `song_all`, `version_all` and `artist_all` give one row per id. The share made each Local Song, Version and
-- Artist a Proposed row with the same uuid and kept the local row (for the Shelved edits that point at it), so the
-- views listed those ids twice: every Video linked to such an Artist showed it twice (a plain tag and a "proposed"
-- one), and removing any Artist from it sent the duplicate back to `write_video_artists replace`, which the archive's
-- one-link-per-Artist index refused (23505). When ids meet, archive beats Proposed beats local, the order the kind
-- lookups already read first.

DROP VIEW IF EXISTS song_all;
DROP VIEW IF EXISTS version_all;
DROP VIEW IF EXISTS artist_all;

CREATE VIEW song_all AS
  SELECT id, name, english_name, alternate_titles, alternate_spellings, is_hidden, 'archive' AS kind FROM archive_song
  UNION ALL
  SELECT id, name, english_name, alternate_titles, NULL, 0, 'proposed' FROM video_proposed_songs p
   WHERE NOT EXISTS (SELECT 1 FROM archive_song a WHERE a.id = p.id)
  UNION ALL
  SELECT id, name, english_name, alternate_titles, alternate_spellings, 0, 'local' FROM local_song l
   WHERE NOT EXISTS (SELECT 1 FROM archive_song a WHERE a.id = l.id)
     AND NOT EXISTS (SELECT 1 FROM video_proposed_songs p WHERE p.id = l.id);

CREATE VIEW version_all AS
  SELECT id, song_id, label, display_order, cyrillic, transliteration, translation,
         footnotes_cyrillic, footnotes_transliteration, footnotes_translation, 'archive' AS kind FROM archive_version
  UNION ALL
  SELECT id, COALESCE(song_id, proposed_song_id), label, 0, lyrics_cyrillic, lyrics_transliteration, lyrics_translation,
         footnotes_cyrillic, footnotes_transliteration, footnotes_translation, 'proposed' FROM video_proposed_versions p
   WHERE NOT EXISTS (SELECT 1 FROM archive_version a WHERE a.id = p.id)
  UNION ALL
  SELECT id, song_id, label, display_order, cyrillic, transliteration, translation,
         footnotes_cyrillic, footnotes_transliteration, footnotes_translation, 'local' FROM local_version l
   WHERE NOT EXISTS (SELECT 1 FROM archive_version a WHERE a.id = l.id)
     AND NOT EXISTS (SELECT 1 FROM video_proposed_versions p WHERE p.id = l.id);

-- The Various Artists sentinel is a plain-text credit, never a Video's Artist.
CREATE VIEW artist_all AS
  SELECT a.id, a.name, l.name_latin, l.name_latin_source, a.is_hidden, a.kind FROM (
    SELECT id, name, is_hidden, 'archive' AS kind FROM archive_artist WHERE is_various_artists = 0
    UNION ALL
    SELECT id, name, 0, 'proposed' FROM video_proposed_artists p
     WHERE NOT EXISTS (SELECT 1 FROM archive_artist a WHERE a.id = p.id)
    UNION ALL
    SELECT id, name, 0, 'local' FROM local_artist x
     WHERE NOT EXISTS (SELECT 1 FROM archive_artist a WHERE a.id = x.id)
       AND NOT EXISTS (SELECT 1 FROM video_proposed_artists p WHERE p.id = x.id)
  ) a LEFT JOIN artist_latin l ON l.artist_id = a.id;
