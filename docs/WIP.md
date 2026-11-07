# Work in progress (historical, 2026-10-11)

*Historical note, checked 2026-11-04.* This file recorded uncommitted work at the end of the 2026-10-11 session. All three items have since landed on `main`:

1. Resuming the Video ends Studio playback (`closeStudioRef` in `src/web/Player.tsx`; spec §7.4).
2. The Player focus ring corners when the State panel sits under the Studio bar (`src/web/styles.css`).
3. `fetch-youtube-info` runs the suggest step on the ids it fetched, with `--no-suggest` to skip it (`scripts/fetch-youtube-info.ts`; README, spec §8).

One question is still open. When `--force` is given with explicit ids, should it refetch only those ids? Today the explicit ids are added to the eligible list (`eligibleForFetch`), so `--force <id>` refetches every eligible Video. To verify the suggest step on one id cheaply, move that id's `<id>.info.json` out of the cache and run `bun scripts/fetch-youtube-info.ts <id>`.
