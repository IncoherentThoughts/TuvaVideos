-- 0016: Rutube ids (ADR 0008, sharing-spec §3.2, §4.3). The 34 Copies downloaded from rutube.ru are named
-- `… [rutube-<32 hex>].<ext>` by scripts/download-rutube.sh; the scan now parses that suffix (filename.ts) into
-- `videos.rutube_id`, provenance like the Instagram shortcode. Here: backfill the column from the Copy filenames, strip
-- the suffix from the titles (and Latin titles) that still carry it, and parse the id (and `t=` offset) out of the
-- archive's rutube.ru performance URLs so scan defaults can match on it. Same rules as `parseFilename` and
-- `parsePerformanceUrl` in TypeScript.

UPDATE videos SET rutube_id = (
  SELECT lower(substr(c.rel_path, instr(c.rel_path, '[rutube-') + 8, 32))
  FROM copy c
  WHERE c.video_id = videos.id AND instr(c.rel_path, '[rutube-') > 0
    AND substr(c.rel_path, instr(c.rel_path, '[rutube-') + 40, 2) = '].'
    AND substr(c.rel_path, instr(c.rel_path, '[rutube-') + 8, 32) NOT GLOB '*[^0-9a-fA-F]*'
  ORDER BY c.id LIMIT 1)
WHERE rutube_id IS NULL;

UPDATE videos SET title = rtrim(substr(title, 1, length(title) - 41))
WHERE length(title) > 41 AND substr(title, length(title) - 40, 8) = '[rutube-' AND substr(title, -1) = ']'
  AND substr(title, length(title) - 32, 32) NOT GLOB '*[^0-9a-fA-F]*'
  AND rtrim(substr(title, 1, length(title) - 41)) <> '';
UPDATE videos SET title_latin = rtrim(substr(title_latin, 1, length(title_latin) - 41))
WHERE length(title_latin) > 41 AND substr(title_latin, length(title_latin) - 40, 8) = '[rutube-' AND substr(title_latin, -1) = ']'
  AND substr(title_latin, length(title_latin) - 32, 32) NOT GLOB '*[^0-9a-fA-F]*'
  AND rtrim(substr(title_latin, 1, length(title_latin) - 41)) <> '';

UPDATE archive_performance SET rutube_id = lower(substr(url, instr(url, 'rutube.ru/video/') + 16, 32))
WHERE instr(url, 'rutube.ru/video/') > 0
  AND substr(url, instr(url, 'rutube.ru/video/') + 16, 32) NOT GLOB '*[^0-9a-fA-F]*'
  AND length(substr(url, instr(url, 'rutube.ru/video/') + 16, 32)) = 32;
UPDATE archive_performance SET start_s = CAST(substr(url, instr(url, '?t=') + 3) AS INTEGER)
WHERE rutube_id IS NOT NULL AND start_s IS NULL AND instr(url, '?t=') > 0;
UPDATE archive_performance SET start_s = CAST(substr(url, instr(url, '&t=') + 3) AS INTEGER)
WHERE rutube_id IS NOT NULL AND start_s IS NULL AND instr(url, '&t=') > 0;

-- The title fix changes indexed text; the companion rebuilds the index at startup.
