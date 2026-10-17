# Themes

What it takes to let TuvaVideos wear the palettes of the MigakuEA fork (`MigakuEA-Fork/palettes/`), which this project
calls **themes**. Written 2026-10-16 with the Lawson Night prototype (`src/web/themes/lawson-night/`); the prototype
takes the first slice of every step below, by hand, so the shape could be judged before any generator is written.
The second theme, **Mecha no Onna** (`src/web/themes/mecha-no-onna/`, the same day), is the same shape by hand again:
the fork's palette with only its first drawing (`mecha-bg1.webp`, the sepia cyborg woman; the geisha and the armoured
girl, and their per-picture colours, stay in the fork), and the fork's Hyprland look rebuilt on this app's selectors.

## What the fork does, in its own words

- **Palette** (`palettes/<id>.json`): id, label, description, a `light` and/or `dark` variant of ten colours named by
  **role** (`bg surface text muted brand negative warning info success action`), optional gender colours, optional
  add-ons (`wallpaper`: `.webp` files in `palettes/<id>/`, a default per variant), and the Omarchy `source`. Validated
  by `tools/palettes/index.mjs` (hex colours, text/bg ≥ 4.5:1, muted/bg ≥ 3:1, images exist).
- **Emitter** per consumer (`migaku/tools/skins/emit.mjs`): a pure function from the roles to that consumer's own CSS
  custom properties (Migaku's `--background`, `--accent-1`, contrast tiers, elevation…), written as formulas of the
  roles, never stored. Emitted into one generated stylesheet keyed on `[data-mgk-skin=<id>]`; a registry (`MGK_SKINS`)
  lists what the picker shows.
- **Overrides** (`migaku/skins/overrides/<id>.json`): per-palette values for a fixed, named set of settings the emitter
  understands (wallpaper strength and focus, frosting per surface, blur). Never free CSS. ADR 0003.
- **Look** (`palettes/<id>/look/<view>.css`): the hand-written appearance beyond colours, one stylesheet per view,
  every selector scoped to `[data-mgk-skin="<id>"]`, linked only while that palette is active. `--look-*` properties at
  the top are the look's settings. Lawson Night's look is "tiled windows over the desktop": a gap all round, 16px
  corners, dark glass (`backdrop-filter` blur + a tinted veil), hairline borders, no glows. `docs/looks.md` lists the
  traps (glass on a `::before` at `z-index: -1`, never on a container that holds menus).
- **Backdrop**: `data-mgk-backdrop=image` on the root, the picture as `html::before { position: fixed; z-index: -1 }`,
  surfaces frosted by `color-mix(bg, transparent)` per the override settings.
- **Mode** is separate from the palette; the theme mirror and the Anki export do not concern us.

## What TuvaVideos has today

- One stylesheet, `src/web/styles.css`, served as `/app.css`. Every colour is one of 19 `:root` tokens:
  `--bg --bg2 --bg3 --line --fg --fg2 --fg3 --accent --accent-fg --ok --no` and the eight **tag slots** `--t1…--t8`
  (gruvbox; Type uses a fixed slot, Artists hash to one, the quality ramp and the State panel's value kinds use them
  too). Tags are tints: `color-mix(var(--c) 18%)` fill, 45% border. `docs/design-direction.md` fixes the "Wall" look.
- No theme attribute, no per-user settings store (the only client preference is `localStorage tuva.lyricsScript`).
- Static files are served by name in `src/server/api.ts` (`/app.js`, `/app.css`, `/olchey.svg`); the UI is bundled by
  `src/server/web.ts` at start.
- Exceptions to the tokens: a few hard `#000`/`#fff` on the Player (OSD, scrub, head), the chip select's chevron is a
  data-URI SVG with Wall's `--fg2` baked in, `rgba(0,0,0,…)` shadows everywhere (fine on any dark theme).

## What has to be added

1. **The role → token mapping.** TuvaVideos' emitter: the ten roles become the 19 tokens as formulas
   (`--bg2 = mix(bg 55%, surface)`, `--line = mix(text 12%, bg)`, `--fg3 = mix(muted 70%, bg)`, `--accent = brand`,
   `--ok = success`, `--no = negative`). The roles do not cover the **eight tag slots**: a theme adds a `tags` array of
   eight hues (the way the fork's palettes carry optional gender colours). Lawson Night's are catppuccin's red, peach,
   yellow, green, teal, blue, mauve, lavender in the gruvbox slots' order, so song/concert/interview/other keep their
   hue family. The prototype writes this block by hand in `theme.css`, already in formula form.
2. **Theme files.** `src/web/themes/<id>/theme.json` (the fork's palette schema plus `tags`), `theme.css` (the emitted
   tokens and the look, every selector under `html[data-theme="<id>"]`), and the wallpaper next to them. Copy the
   palette JSON from the fork as it is; a theme without a look is painted by the tokens alone.
3. **Serving.** `GET /themes/<id>/<file>` from `webDir/themes` (css, json, webp, png, svg; no `..`). Added.
4. **Applying.** `data-theme` on `<html>` plus a `<link>` to the theme's stylesheet, set before first paint by an inline
   script in `index.html` reading `localStorage tuva.theme`, and swapped at runtime by `src/web/theme.ts`
   (`?theme=<id>` in the URL also picks one, for trying a theme from a link). Added. The TV app has its own styles and
   is out of scope.
5. **Choosing.** A Theme select in the top bar (prototype) → later a Settings surface, if one appears, and the `tuva:`
   command-style prompt parked in design-direction.md would be the natural home for `:theme lawson-night`.
6. **The look for every screen.** Lawson Night's prototype covers the shell (top bar, search dropdown, menus, toasts,
   buttons, chips, fields) and every `.page` screen (Library, Favorites, Artists, Songs, search results) as one glass
   window each. **Now playing** (`.np`, the Player, the drawers) and the dialogs get the colours only; the glass needs a
   pass of its own: the drawer's sticky `top` assumes the top bar sits flush at `0`, the Player's `#000` stage and the
   control bar's `--bg2` should become a window, and nothing may put `backdrop-filter` on `.player` (its menus are
   positioned inside it).
7. **Generator + validation** (when a second theme arrives): a script that reads every `theme.json`, checks it with the
   fork's rules (contrast, files exist, eight tags), writes the token block of each `theme.css` between markers and the
   registry `theme.ts` reads. The second theme is here; the registry is still a hand-kept list of three.
8. **Loose ends to make themeable**: the select chevron (use `currentColor` via a mask), the Player's `#fff`/`#000`
   (deliberate on video, leave), `<meta name="color-scheme">` if a light theme ever lands (Lawson Night is dark only,
   like the fork says).

## Look settings carried over from the fork's Lawson Night

`--look-gap 10px`, `--look-radius 16px`, `--look-glass-blur 28px`, `--look-glass-tint .62`, `--look-panel-tint .8`,
`--look-field-tint .45`, `--look-field-radius 10px`, border `brand 45%`, wallpaper clarity `.92`, focus `40% 70%`
(from `migaku/skins/overrides/lawson-night.json`: that is where the shop and Fuji sit in the picture).

## Look settings carried over from the fork's Mecha no Onna

From `palettes/mecha-no-onna/look/migaku-core.css` and `migaku/skins/overrides/mecha-no-onna.json`, the first drawing's
values: `--look-gap 8px`, `--look-radius 5px`, a `2px` frame (`#45413a` at 70% on a window, a cream `#fbf1c7` → black
fade on the focused one), `--look-glass-tint .8`, `--look-glass-blur 9px` with `brightness(.85) contrast(1.05)
saturate(1.15)`, `--look-panel-tint .86`, `--look-field-radius 4px`, `--look-field-tint .5` over `#0d0c0a`, wallpaper
strength `.75` and focus `45% 40%` (her face). The type is JetBrains Mono for the UI (`--font-ui` is pointed at
`--font-mono`; lyrics keep `--font-lyrics`), tabs in spaced capitals (`.22em`). Accents by job: sand (`brand`) for
frames of chosen things and focus, amber (`action`, `#e7c07c`) as a solid plate with ink letters for the chosen chip,
pill, segment and primary button, and vermilion `#d94e38` kept to one mark, the playing line in the search results.
The focused window (`.page`, `.np-main`) draws its gradient frame on a `::after` kept to the border by a mask; the
top bar, drawers and floating menus wear the quiet frame as a `box-shadow` ring.
