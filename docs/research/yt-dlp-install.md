# Research: yt-dlp standalone install, self-update and JS runtime

Resolves [#187](https://github.com/IncoherentThoughts/TuvaVideos/issues/187) (part of map #186, blocks #194). Question: how does the app install and keep current yt-dlp's standalone binary on macOS, Linux and Windows, does YouTube extraction need an external JS runtime, can Bun serve as it, and how is ffmpeg passed?

Read 2026-11-08 against yt-dlp **2026.10.26** (latest stable). Sources: the [yt-dlp README](https://github.com/yt-dlp/yt-dlp/blob/master/README.md), the [release assets](https://github.com/yt-dlp/yt-dlp/releases/latest), [`yt_dlp/update.py`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/update.py), [`yt_dlp/__init__.py`](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/__init__.py) and the [EJS wiki page](https://github.com/yt-dlp/yt-dlp/wiki/EJS). Nothing here was run end to end; "inference" marks anything not stated by a source.

## Answer (TL;DR)

- **Download the PyInstaller standalone from GitHub releases into the data dir.** macOS is one universal `yt-dlp_macos` (arm64 and x64, macOS 10.15+). Windows is `yt-dlp.exe`, Linux `yt-dlp_linux`, `yt-dlp_linux_aarch64`, or the `musllinux` pair. Verify against `SHA2-256SUMS` from the same release.
- **`yt-dlp -U` works for the standalone binary and is safe to run unattended.** It checks the same SHA-256 itself, swaps the file in place, and a bare `-U` does not restart or download anything. The data dir must be writable by the app. It stays on its current channel (stable by default).
- **YouTube needs a JS runtime now, but not a separate EJS install.** The solver scripts (`yt-dlp-ejs`) are bundled in the official executables. Only a runtime is required.
- **Bun is the wrong choice.** yt-dlp lists Bun as **deprecated**, supports only 1.2.11 to **1.3.14**, and this machine has Bun **1.4.4**. Deno is the only runtime enabled by default and the recommended one. Node 22+ is the other sane option.
- **ffmpeg:** pass `--ffmpeg-location` with the path `findBin` already resolved. yt-dlp accepts a binary or its directory.

## 1. Release assets and checksums

The README's release-file tables list, per platform ([README](https://github.com/yt-dlp/yt-dlp#release-files)):

| Platform | Asset (standalone, self-updating) | Notes |
|---|---|---|
| macOS arm64 + x64 | `yt-dlp_macos` | "Universal MacOS (10.15+) standalone executable (recommended for MacOS)". One file for both CPUs. |
| Windows x64 | `yt-dlp.exe` | Win10+. Also `yt-dlp_x86.exe`, `yt-dlp_arm64.exe`. |
| Linux x86_64 / aarch64 (glibc 2.17+) | `yt-dlp_linux`, `yt-dlp_linux_aarch64` | |
| Linux musl | `yt-dlp_musllinux`, `yt-dlp_musllinux_aarch64` | |
| any Unix with Python | `yt-dlp` | zipimport script, needs Python 3.11+; not what we want. |

The `*.zip` variants (`yt-dlp_macos.zip`, `yt-dlp_win.zip`, ...) are "unpackaged" onedir builds marked "(no auto-update)". Do not use them. Sizes in the 2026.10.26 release: `yt-dlp_macos` 37.5 MB, `yt-dlp.exe` 23.6 MB, `yt-dlp_linux` 41.2 MB ([release assets](https://github.com/yt-dlp/yt-dlp/releases/tag/2026.10.26)).

Each release also carries `SHA2-256SUMS`, `SHA2-512SUMS` and a GPG `.sig` for each. `SHA2-256SUMS` is GNU-style (`<hex>  <asset name>`), one line per asset, and the README documents `gpg --verify SHA2-256SUMS.sig SHA2-256SUMS` ([README](https://github.com/yt-dlp/yt-dlp#release-files)). A URL of the form `https://github.com/yt-dlp/yt-dlp/releases/latest/download/<asset>` always serves the newest stable asset.

**Install recipe (inference from the above):** fetch `.../releases/latest/download/SHA2-256SUMS`, find the line for our asset, download the asset, compare SHA-256, `chmod +x`, atomically rename into `<dataDir>/bin/`. GPG verification is optional extra assurance and would need a pinned public key, which is more than the app should carry. A plain SHA-256 from the same release protects against corruption but not against a compromised release; that is exactly the check yt-dlp's own updater does.

**macOS caveat, untested:** a binary written by the app with `fetch` carries no quarantine attribute, so Gatekeeper should not prompt. Verify on a clean Mac in #194. Not covered by any source read here.

## 2. How `-U` behaves for the standalone build

From `yt_dlp/update.py` and `__init__.py`:

- **Variant detection.** A frozen PyInstaller "onefile" build is detected and mapped to its asset name (`darwin_exe` to `_macos`, `win_exe` to `.exe`, `linux_exe` to `_linux`, and so on). Onedir builds, source runs and package-manager installs are refused with an explanatory error (`_NON_UPDATEABLE_REASONS`).
- **Checksum.** `query_update` downloads `SHA2-256SUMS` for the target tag and picks the line matching the binary name. `update()` then hashes the downloaded bytes and aborts with a network error on mismatch. If no checksum is found it still updates but blocks the automatic restart "for security reasons".
- **Replacement.** It needs write access to both the file and its directory (`os.access`, else a permission error). It writes `<exe>.new`, renames the current exe to `<exe>.old`, renames `.new` into place, then removes `.old`, restoring the original on failure. On Windows the `.old` file is deleted by a detached `ping & del` at exit because a running exe cannot be removed. It restores the original file mode afterwards.
- **Channel.** "When using `--update`/`-U`, a release binary will only update to its current channel." Default is `stable`. `--update-to nightly` or `master` switches channel ([README, Update](https://github.com/yt-dlp/yt-dlp#update)). The README calls `nightly` the "recommended channel for regular users" and warns that `stable` "is often 'stale' and prone to external breakage". That matters for a YouTube downloader; the cost is that nightly is somewhat more bug-prone. Nightly builds come from `yt-dlp/yt-dlp-nightly-builds`.
- **Restart.** After a successful update, `__init__.py` restarts the process only if there are also URLs to download (`actual_use and updater.cmd`). A bare `yt-dlp -U` just updates and exits.
- **Unattended.** Nothing prompts. It is network-bound (one API call for the release, one for `_update_spec`, one for `SHA2-256SUMS`, then the ~40 MB asset only when a newer tag exists), so running `yt-dlp -U` before each job should cost a few hundred ms when current (inference, not timed). Still rate-limit it (say once per day or after a failed extraction) to stay under GitHub API limits and to avoid replacing the binary while another job is running it (see the Windows note above).
- **Warning.** yt-dlp prints a warning when its version is over 90 days old; `--no-update` silences it ([README](https://github.com/yt-dlp/yt-dlp#update)).
- **Alternative to `-U`.** The app could do the same dance itself: compare the latest tag, redownload the asset, verify via `SHA2-256SUMS`. `-U` is less code and uses the project's own verified path, so prefer `-U` and treat a failure as "keep the old binary".

## 3. JS runtime (EJS)

The [EJS wiki page](https://github.com/yt-dlp/yt-dlp/wiki/EJS) opens: "To download from YouTube, yt-dlp needs to solve JavaScript challenges presented by YouTube using an external JavaScript runtime." The README lists `yt-dlp-ejs` plus a runtime under "Strongly recommended" dependencies ([README, Dependencies](https://github.com/yt-dlp/yt-dlp#dependencies)). So the answer to "does YouTube now need an external JS runtime" is yes, in practice.

- **Solver scripts:** the wiki's table says for official PyInstaller executables, "No additional action required. `yt-dlp-ejs` is bundled with these executables." `--remote-components` is "currently not needed if you are using an official executable" ([README](https://github.com/yt-dlp/yt-dlp#general-options)). Default is that no remote components are allowed; keep it that way.
- **Runtimes and enabling** ([EJS wiki](https://github.com/yt-dlp/yt-dlp/wiki/EJS), [README `--js-runtimes`](https://github.com/yt-dlp/yt-dlp#general-options)):

| Runtime | Minimum | Enabled by default | Notes |
|---|---|---|---|
| deno | 2.3.0 | **yes** | Recommended. Code runs with no filesystem or network access. Download `deno`, not `denort`. |
| node | 22.0.0 | no, `--js-runtimes node[:PATH]` | Some permissions restricted. |
| quickjs / quickjs-ng | 2023-12-9 / any | no | Older versions can take minutes; binary must be named `qjs` or given by path. |
| **bun** | 1.2.11, latest **1.3.14** | no, `--js-runtimes bun[:PATH]` | **Deprecated**: "Versions after `1.3.14` are not supported, and support may be dropped entirely." No permission restrictions, scripts get full filesystem and network access. |

  Priority when several are enabled, highest first: deno, node, quickjs, bun. The runtime is found on `PATH` or via `--js-runtimes "name:/path"`.
- **Can Bun serve?** Not reliably. The app runs on Bun **1.4.4** here (`bun --version`), above the last supported 1.3.14, and `process.execPath` is exactly that binary. It would also run YouTube's code with full file and network access. Do not point `--js-runtimes bun:` at the app's own Bun.
- **Does the app need to install deno too?** Something must exist; the simplest self-contained choice is to download the `deno` release binary into `<dataDir>/bin/` and pass `--js-runtimes deno:<dataDir>/bin/deno` (inference; deno's own asset names and checksum scheme were not researched here, left for #194). If the user already has Node 22+ or deno on PATH, detect it first. Because deno is on by default, a deno on PATH needs no flag.
- **Failure mode:** with no usable runtime, YouTube extraction degrades or fails with a warning from yt-dlp; #194 should surface the missing-runtime state to the user (inference, not tested).

## 4. ffmpeg

README: `--ffmpeg-location PATH` is the "path to the binary or its containing directory". `__init__.py` just expands it (`expand_path`) and hands it to the downloader and postprocessors. yt-dlp needs both `ffmpeg` and `ffprobe` for merging and postprocessing ([README, Dependencies](https://github.com/yt-dlp/yt-dlp#dependencies)).

The app's `findBin` (`src/server/config.ts`) resolves `TUVA_BIN_DIR`, `/opt/homebrew/bin`, `/usr/local/bin`, then `PATH`, and `config.ffmpeg` / `config.ffprobe` are resolved separately. Recommended (inference): pass `--ffmpeg-location dirname(config.ffmpeg)` when `ffprobe` lives in the same directory (the normal case, e.g. Homebrew); otherwise pass the `ffmpeg` path and put the ffprobe directory on the child's `PATH`. This keeps yt-dlp on the same ffmpeg the rest of the app uses, including the native arm64 Homebrew preference. yt-dlp also publishes its own ffmpeg builds at `yt-dlp/FFmpeg-Builds` as an option when none is installed.

## 5. Where it goes in the data dir

The data dir is per platform (`dataDirFor`, `src/server/config.ts`: `~/Library/Application Support/TuvaVideos`, `$XDG_DATA_HOME/TuvaVideos`, `%APPDATA%\TuvaVideos`). Proposal (inference): `<dataDir>/bin/yt-dlp[.exe]` and `<dataDir>/bin/deno[.exe]`. Reasons: it must be writable by the user so `-U` can create the `.new`/`.old` files; it is outside the source checkout; and putting `<dataDir>/bin` after `TUVA_BIN_DIR` in the lookup chain lets a Homebrew `yt-dlp` still win for users who prefer it. A Homebrew or pip yt-dlp is not self-updatable (the `'unknown'` variant above), so the app should only call `-U` on the binary it installed.

## Decisions for #194

1. Install `yt-dlp_macos` / `yt-dlp.exe` / `yt-dlp_linux[_aarch64|musl]` into `<dataDir>/bin/`, verified against `SHA2-256SUMS`.
2. Update with `yt-dlp -U` (optionally `--update-to nightly`), at most daily and never while a download is running; keep the old binary on failure.
3. Use deno (default-enabled) or Node 22+; **never Bun**. Download a deno binary into `<dataDir>/bin/` if none is found.
4. Pass `--ffmpeg-location` from `findBin`'s result.
5. Unverified, test in #194: Gatekeeper on a fresh Mac, deno asset and checksum details, behaviour when no runtime is present.
