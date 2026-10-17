# TV home and Player prototype (#50, #51) — PROTOTYPE, throwaway

Three variants of the TV app's home screen (#50), three variants of the Player (#51), one Search. Driven by the arrow keys, Enter and Backspace in a browser, or the remote on
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
- Player (#51): `?player=A|B|C`, or the yellow bar / `v` / red while a Video plays (it replays at the same time).
  `?play=<video id>&t=<s>` opens a Video straight away, e.g. `?play=1621&t=560` (a 27-Chapter concert with lyrics).
  In all three: `↑` the tag row (Left/Right, Enter opens a grid of that Type / Artist / Song's Videos), `↓` Chapters,
  Enter pause, `y` lyrics on/off, `s` Script, `< >` previous/next in Playing from, Backspace closes an overlay first
  and leaves second. On the remote: yellow = lyrics, blue = Script, green = Chapters.
  - **A Reader beside**: the video shrinks beside a static numbered lyrics column (Ch▲▼ / PgUp PgDn page it); the
    Chapter strip is a filmstrip over the bottom; the OSD fades; `← →` ±10 s, Rew/FF ±60 s.
  - **B Overlay**: the whole video stays visible, letterboxed beside a standalone lyrics column; the column's
    background is the Video's poster blurred and slowly drifting under a dark tint, vignette and grain (the album
    page's ambient backdrop on the Lyrics Website, made to move); the column sizes itself to its longest line (720 to
    1060 px), the type shrinking first (44 down to 34 px); `↓` opens a vertical Chapter list over the video's left
    edge (Up/Down, Enter); a Netflix-style bar names the current Chapter and "Next:" in the last 20 s; `← →`
    accelerate 10 → 30 → 60 → 120 s when pressed again within a second.
  - **C Stage**: the video sits in a 1240×697 window; the lyrics column follows an *estimated* current line (position
    in the Chapter mapped onto the lines; no timings exist) with the translation under each line; Chapter cards and
    the info row are always visible in a band below (`↓` focuses the cards); `← →` move a ghost playhead with a strip
    frame ±5 s and commit after 0.7 s or Enter; Rew/FF (and Ch▲▼) jump to the previous/next Chapter.

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
