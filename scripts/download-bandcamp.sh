#!/bin/zsh
# Downloads the bandcamp performances listed in bandcamp-urls.txt into Khöömei Batch 10.
# Re-runnable: finished ids are recorded in the archive file and skipped; failures are logged and the run continues.
DEST="/Users/evanwilliams/Desktop/Khöömei Batch 10"
HERE="${0:A:h}"
mkdir -p "$DEST"

yt-dlp \
  --batch-file "$HERE/bandcamp-urls.txt" \
  --paths "$DEST" \
  --output "%(artist,uploader)s - %(title)s [bandcamp-%(id)s].%(ext)s" \
  --download-archive "$DEST/.downloaded.txt" \
  --ignore-errors \
  --no-overwrites \
  --continue \
  --retries 5 \
  --sleep-interval 3 --max-sleep-interval 8 \
  --write-info-json --newline \
  2>&1 | tee -a "$DEST/download.log"

echo "Done. Failures (if any): grep -i 'error' \"$DEST/download.log\""
