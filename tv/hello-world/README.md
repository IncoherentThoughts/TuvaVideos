# Hello-world TV app (#48)

A throwaway Tizen web app that proves the install path to the Samsung R85H and measures `<video src>` playback of
real Copies served from the Mac. `serve.ts` is a separate LAN test server (0.0.0.0:4410). The app's own server stays
on 127.0.0.1.

## Setup (done once, 2026-10-13)

- Tizen Studio 6.1 at `~/tizen-studio`, installed headless:
  `java -cp installer.jar org.tizen.installer.cli.CLIMain --accept-license ~/tizen-studio`
  (installer.jar and the bundled JDK 8 come from `web-ide_Tizen_Studio_6.1_macos-64.dmg`; x86_64, runs under Rosetta).
- Packages: `package-manager-cli.bin install --accept-license cert-add-on Certificate-Manager TV-SAMSUNG-Public-WebAppDevelopment TV-SAMSUNG-Extension-Tools TV-SAMSUNG-Extension-Resources`
  (Samsung Certificate Extension 2.0.75).
- Certificate profile **TuvaVideos** (Samsung, TV, Public): files in `~/SamsungCertificate/TuvaVideos/`, profile
  registry `~/tizen-studio-data/profile/profiles.xml`. Author and distributor certificates both expire **2027-10-14**.
  Back up `~/SamsungCertificate/TuvaVideos/`: updates must be signed with the same author certificate.
- TV: DUID `MTCNLIPDV7U3W`, IP `192.168.4.56`, sdb port 26101. Developer Mode host IP = the Mac, `192.168.4.83`.

## Build, install, run

```bash
bun tv/hello-world/serve.ts          # in one terminal
cd tv/hello-world
T=~/tizen-studio/tools/ide/bin/tizen
~/tizen-studio/tools/sdb connect 192.168.4.56
$T build-web -e serve.ts -e "*.log" -e "*.jsonl" -e "*.out" -e README.md -- .
$T package -t wgt -s TuvaVideos -o . -- .buildResult && mv "Tuva Hello.wgt" TuvaHello.wgt
$T install-permit -t MRN85R85HAFXZA  # once per certificate
$T install -n TuvaHello.wgt -t MRN85R85HAFXZA
$T run -p TuvaHello1.HelloTV -t MRN85R85HAFXZA
```

On the TV: Enter on "Run all tests". Results land in `results.jsonl`, request headers in `requests.log`.

## Gotchas

- `sdb connect` fails with "failed to connect to remote target" while Certificate Manager is open: it holds its own
  sdb session. Quit it (and `pkill -f "sdb fork-server"`) first.
- After a power cycle the TV may drop Developer Mode; re-enter it (Apps › App Settings › 12345) and restart the TV.
- The TV never fires `requestVideoFrameCallback` again after a seek, so time-to-playing-after-seek uses `timeupdate`
  (about 250 ms granularity).
- The Mac firewall is on but did not block the TV's requests to bun.

## Results

`results-run1.jsonl` (seek frame not measured) and `results-run2.jsonl`. Summary in #48.
