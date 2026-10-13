#!/bin/zsh
# Downloads the YouTube performances listed in doc-missing-youtube-ids.txt (reference doc videos not yet in the library) into Batch 8.
# Re-runnable: finished ids are recorded in the archive file and skipped; failures are logged and the run continues.
# Download rule (spec 2): at most 1080p, VP9 or H.264 over AV1 (an M1 decodes AV1 in software; VP9 and H.264 in hardware).
DEST="/Users/evanwilliams/Desktop/Batch 8"
HERE="${0:A:h}"
mkdir -p "$DEST"

yt-dlp \
  --batch-file "$HERE/doc-missing-youtube-ids.txt" \
  --no-playlist \
  --paths "$DEST" \
  --output "%(title)s [%(id)s].%(ext)s" \
  --format "bv*+ba/b" \
  --format-sort "res:1080,vcodec:vp9" \
  --merge-output-format mkv \
  --download-archive "$DEST/.downloaded.txt" \
  --ignore-errors \
  --no-overwrites \
  --continue \
  --retries 5 \
  --sleep-interval 3 --max-sleep-interval 8 \
  --write-info-json \
  2>&1 | tee -a "$DEST/download.log"

echo "Done. Failures (if any): grep -i 'error' \"$DEST/download.log\""
