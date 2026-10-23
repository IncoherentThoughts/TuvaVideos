# TuvaVideos TV shell

The thin, signed Tizen app (`TuvaVideos.TuvaTV`), also packaged for LG webOS (`local.tuvavideos.tuvatv`), that finds the TV Server on the Mac and loads the TV UI live from it
(`docs/tv-spec.md` §4). Plain ES2020 scripts, no bundler: what is in this folder is what runs on the TV.

| File | Job |
|---|---|
| `config.xml`, `icon.png` | package: `internet` + `tv.inputdevice` privileges, `<access origin="*" subdomains="true"/>`, olchey icon 512x423 (the knot on a full-bleed `#1f1e1d` fill) |
| `appinfo.json`, `icon-80.png`, `icon-130.png` | the LG (webOS) package: `disableBackHistoryAPI` so Back arrives as key 461; read by `lg-install` |
| `index.html`, `shell.css` | CSP meta (as jellyfin-tizen ships), `webapis.js`, the 1920x1080 offline screens |
| `discovery.js` | finding the server (last address, /24 sweep, typed), approval, "turned off"; no DOM, tested in `test/tv-shell.test.ts` |
| `shell.js` | key registration, screens, loading `/tv.css` and `/tv.js` from the server, `window.tuvaTv = { base, keys, exit, restart }` |
| `keys.js` | **generated** from `src/tv/keys.ts` by `bun run tv-install` (or `bun scripts/tv-install.ts --keys`); a test fails when it is stale |
| `tv.json` | the TV: `ip`, `target` (model code for `-t`), `duid`, `mac` (the Mac's address, for reference); read by `tv-install` |

## Develop in a desktop browser

No Tizen needed: the shell guards every `tizen`/`webapis` call.

```bash
bun run start                    # the app; switch the TV button on (TV Server on :4401)
cd tv/shell && python3 -m http.server 8081
# open http://127.0.0.1:8081/?addr=127.0.0.1
```

`?addr=` stands in for the address the TV would have stored. Use `127.0.0.1` (not `localhost`) as the page's own host.
Keys: Enter, digits, the arrows (walk the on-screen number pad of the typing screen), Backspace (stands in for Back). The server must answer CORS for
`X-Tuva-TV` from a page on another port; the packaged app on the TV has the same constraint.

## Install on the TV

```bash
bun run tv-install               # sdb connect, build-web, package, install, run
bun run tv-install --permit      # the first time per certificate: also `tizen install-permit`
```

It prints every command and stops on the first failure with Tizen's output. Installing a newer version replaces the
old one. **UI changes need no reinstall**: the shell loads `/tv.js` and `/tv.css` from the TV Server at every launch.
Only changes in this folder need `tv-install`.

Tools are expected at `~/tizen-studio` (Tizen Studio 6.1, Samsung Certificate Extension 2.0.75, TV Extensions 10.0),
certificate profile `TuvaVideos` (Samsung, TV, Public; files in `~/SamsungCertificate/TuvaVideos/`). Back that folder
up: updates must be signed with the same author certificate.

## Install on an LG TV (webOS)

The same shell, packaged as an `.ipk` instead of a `.wgt`. On LG no key needs registering (Back is 461, in `alt` in
`src/tv/keys.ts`), the TV's own address comes from `luna://com.palm.connectionmanager/getStatus`, and the app runs
from `file://`, so the TV Server answers CORS on every TV route.

Once:

1. `bunx npm@10 install --prefix ~/.webos-cli @webos-tools/cli` (the `ares-*` tools, in `~/.webos-cli/node_modules/.bin`;
   `lg-install` finds them there). Not `bun add -g`: bun ignores the package's pinned dependencies and `ares-package`
   fails with "mkdir is not a function".
2. On the TV: sign in to an LG account, install **Developer Mode** from the LG Content Store, open it, sign in with
   the same account and switch **Dev Mode Status** on (the TV restarts). Reopen it and switch **Key Server** on; note
   the IP and the 6-character passphrase it shows.
3. `~/.webos-cli/node_modules/.bin/ares-setup-device --add lgtv -i "host=<TV IP>" -i "port=9922" -i "username=prisoner"`, then
   `~/.webos-cli/node_modules/.bin/ares-novacom --device lgtv --getkey` and type the passphrase.

Then, and after every change in this folder:

```bash
bun run lg-install               # package, install, launch on the device named lgtv
bun run lg-install otherdevice   # another ares-setup-device name
```

Developer Mode on LG lasts 50 hours: open the Developer Mode app and press **Extend** before it runs out, or the
sideloaded app is removed. The first launch shows **Approve this TV on the Mac** like the Samsung one.

## Yearly certificate checklist

Author and distributor certificates **expire 2027-10-14**. Renewal needs a Samsung account sign-in, so it is a chore,
not automated. Nothing new can be installed after expiry (whether an installed app keeps launching is unverified).

1. **Quit Certificate Manager before `sdb connect`**: it holds its own sdb session and `sdb connect` fails with
   "failed to connect to remote target" while it is open (`pkill -f "sdb fork-server"` helps).
2. **Developer Mode on the TV**: Apps, then App Settings, type `12345`, switch Developer Mode on, enter the Mac's IP
   (`tv.json` `mac`), restart the TV. Developer Mode is dropped by a power cycle: do this again after one.
3. Open Certificate Manager, **create a new distributor certificate** for the profile `TuvaVideos` with the TV's DUID
   (`tv.json` `duid`, also Menu, Support, Contact Samsung), and sign in with the Samsung account. Renew the author
   certificate if it is due as well.
4. `bun run tv-install --permit` (`tizen install-permit` pushes the new distributor certificate to the TV, then the
   shell is rebuilt, re-signed, installed and launched).
5. Update the expiry date in this README and in `docs/tv-spec.md` §1.

After a **Tizen OS upgrade** the TV may wipe sideloaded apps: re-enable Developer Mode if needed and run
`bun run tv-install` again.

## What the shell shows

- **Looking for TuvaVideos on the Mac…** with the step it is on (last address, sweep of the TV's /24 on 4401, 32 at a
  time with 2 s timeouts); the whole sequence repeats every 5 s. Enter opens the typed field, Back exits.
- **The Mac's address**: the TV's own subnet is pre-filled, so `83` is enough; digits type, Up types a dot, Back deletes
  (and leaves the field when empty), Enter connects.
- **Approve this TV on the Mac**: a 403 from `/api/videos`; retried every 3 s until Allow is clicked.
- **TV Server turned off**: the health check missed twice (5 s apart) after a success; Enter reloads the shell and
  looks again, Back exits.
