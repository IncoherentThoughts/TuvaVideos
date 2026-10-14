# TV home prototype (#50) — PROTOTYPE, throwaway

Three variants of the TV app's home screen, one Player with the lyrics Reader beside the video (static, as on Now
playing in the browser app), one Search. Driven by the arrow keys, Enter and Backspace in a browser, or the remote on
the TV. Real data from the running app; nothing is written to the library (Resume is read, not saved; views are not
counted).

## Run in a browser

```bash
bun run start          # the app, 127.0.0.1:4400 (if it is not already running)
bun run tv-prototype   # http://localhost:4412/?variant=A
```

- `B` Rails is the chosen home and the default; `?variant=A` Tabs and grid and `C` List and preview are the rejected ones. The yellow bar at the bottom (or `v`, or the red key)
  switches; `&bar=0` hides the bar. The browser app's Library query carries over: `?variant=A&type=concert&sort=added`.
- `i` (or Info on the remote) shows the live state; `r` Random; `/` Search.
- Home (B): Back, or Left at the start of a rail, opens the side pane (Library, Favorites, Artists, Songs as full grids,
  Search, Random); Right closes it; Back inside it exits the app.
- Player: `← →` ±10 s, Enter pause, PageUp/PageDown (Channel ▲▼ on the remote) page the lyrics, `↑` focuses the tags
  above the scrub bar (Left/Right, Enter opens a grid of that Type / Artist / Song's Videos), `↓` Chapter strip,
  `y` lyrics on/off, `s` Script, `< >` previous/next in Playing from, Backspace back.
  On the remote: yellow = lyrics, blue = Script, green = Chapters.

## Install on the TV

Same setup as `tv/hello-world` (#48, branch `task/hello-world-tv`): Tizen Studio 6.1, certificate profile `TuvaVideos`,
TV at 192.168.4.56, Mac at 192.168.4.83. The packaged app talks to `serve.ts` on the Mac (`shared.ts` BASE and
`config.xml` access origin both name `192.168.4.83:4412`), so keep `bun run tv-prototype` running.

```bash
bun run tv-prototype                 # keep running: it builds main.js and proxies the app for the TV
cd tv/home-prototype
T=~/tizen-studio/tools/ide/bin/tizen
~/tizen-studio/tools/sdb connect 192.168.4.56
$T build-web -e "*.ts" -e README.md -e "*.wgt" -- .
$T package -t wgt -s TuvaVideos -o . -- .buildResult && mv TuvaVideos.wgt TuvaTV.wgt
$T install -n TuvaTV.wgt -t MRN85R85HAFXZA
$T run -p TuvaProto1.TuvaTV -t MRN85R85HAFXZA
```

The icon is `src/web/olchey.svg` rendered to 512×423 (Tizen's TV icon size) with ImageMagick.
