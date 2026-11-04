#!/usr/bin/env bash
# Downloads the bandcamp performances listed in bandcamp-urls.txt into Khöömei Batch 10.
# Re-runnable: finished ids are recorded in the archive file and skipped; failures are logged and the run continues.
# Usage: download-bandcamp.sh [dest dir]  (or TUVA_DOWNLOAD_DEST); exits non-zero when yt-dlp is missing or reports a failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-${TUVA_DOWNLOAD_DEST:-$HOME/Desktop/Khöömei Batch 10}}"
command -v yt-dlp >/dev/null || { echo "yt-dlp is not on PATH" >&2; exit 127; }
mkdir -p "$DEST" || exit 1

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

status=$?
if [ "$status" -eq 0 ]; then
  echo "Done."
else
  echo "yt-dlp exited $status. Failures: grep -i 'error' \"$DEST/download.log\"" >&2
fi
exit "$status"
