#!/usr/bin/env bash
# Downloads the instagram performances listed in doc-missing-instagram-urls.txt (reference doc videos not yet in the library) into Batch 8.
# Re-runnable: finished ids are recorded in the archive file and skipped; failures are logged and the run continues.
# Usage: download-instagram.sh [dest dir]  (or TUVA_DOWNLOAD_DEST); exits non-zero when yt-dlp is missing or reports a failure.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="${1:-${TUVA_DOWNLOAD_DEST:-$HOME/Desktop/Batch 8}}"
command -v yt-dlp >/dev/null || { echo "yt-dlp is not on PATH" >&2; exit 127; }
mkdir -p "$DEST" || exit 1

yt-dlp \
  --batch-file "$HERE/doc-missing-instagram-urls.txt" \
  --paths "$DEST" \
  --output "%(title)s [instagram-%(id)s].%(ext)s" \
  --format "bv*+ba/b" \
  --merge-output-format mkv \
  --download-archive "$DEST/.downloaded.txt" \
  --ignore-errors --cookies-from-browser "${YTDLP_COOKIES_BROWSER:-brave}" \
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
