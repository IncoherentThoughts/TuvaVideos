#!/usr/bin/env bash
# Runs download-instagram.sh, then download-bandcamp.sh (each into its own default folder; see each script).
# Both run even if the first reports failures; the exit status is non-zero if either failed.
HERE="$(cd "$(dirname "$0")" && pwd)"
status=0
"$HERE/download-instagram.sh" || status=1
"$HERE/download-bandcamp.sh" || status=1
exit "$status"
