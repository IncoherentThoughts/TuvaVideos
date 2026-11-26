#!/bin/sh
# A stand-in for the tailscale CLI (tests and smoke runs; never the real tailnet). `status --json` prints status.json;
# `whois --json <ip>` prints whois-<ip>.json, or fails like an unknown peer when there is none. Fixtures are read from
# $TUVA_TS_FIXTURES, else from this script's directory.
dir="${TUVA_TS_FIXTURES:-$(dirname "$0")}"
case "$1" in
  status) cat "$dir/status.json" ;;
  whois)
    f="$dir/whois-$3.json"
    if [ -f "$f" ]; then cat "$f"; else echo "peer not found" >&2; exit 1; fi
    ;;
  *) exit 2 ;;
esac
