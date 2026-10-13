-- 0011: Instagram Videos scanned before the filename parser learned yt-dlp's `[instagram-<shortcode>]` suffix kept it
-- in their title (and Latin title). Strip it, plus the `#<shortcode>` of an untitled `Instagram video #<shortcode>`, as
-- the scan now does. Titles without the suffix (hand-edited ones included) are left alone.
CREATE TEMP TABLE ig_title AS
  SELECT id, rtrim(substr(title, 1, instr(title, '[instagram-') - 1)) AS stem,
         '#' || substr(title, instr(title, '[instagram-') + 11, length(title) - instr(title, '[instagram-') - 11) AS hash
  FROM video WHERE title LIKE '%[instagram-%]';
UPDATE ig_title SET stem = rtrim(substr(stem, 1, length(stem) - length(hash))) WHERE stem LIKE '%' || hash;
UPDATE video SET title = (SELECT stem FROM ig_title WHERE ig_title.id = video.id)
  WHERE id IN (SELECT id FROM ig_title WHERE stem <> '');
UPDATE video SET title_latin = rtrim(substr(title_latin, 1, instr(title_latin, '[instagram-') - 1))
  WHERE title_latin LIKE '%[instagram-%]' AND instr(title_latin, '[instagram-') > 1;
DROP TABLE ig_title;
