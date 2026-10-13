#!/bin/zsh
# Downloads the instagram performances listed in doc-missing-instagram-urls.txt (reference doc videos not yet in the library) into Batch 8.
# Re-runnable: finished ids are recorded in the archive file and skipped; failures are logged and the run continues.
DEST="/Users/evanwilliams/Desktop/Batch 8"
HERE="${0:A:h}"
mkdir -p "$DEST"

yt-dlp \
  --batch-file "$HERE/doc-missing-instagram-urls.txt" \
  --paths "$DEST" \
  --output "%(title)s [instagram-%(id)s].%(ext)s" \
  --format "bv*+ba/b" \
  --merge-output-format mkv \
  --download-archive "$DEST/.downloaded.txt" \
  --ignore-errors --cookies-from-browser brave \
  --no-overwrites \
  --continue \
  --retries 5 \
  --sleep-interval 3 --max-sleep-interval 8 \
  --write-info-json --newline \
  2>&1 | tee -a "$DEST/download.log"

echo "Done. Failures (if any): grep -i 'error' \"$DEST/download.log\""
