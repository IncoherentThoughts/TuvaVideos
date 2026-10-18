# TuvaVideos sharing test plan

The scenario lists that `docs/sharing-spec.md` §9.1 asks for, plus the two-machine runbook they run on. The build agent runs it once, driving both machines in the browser after `bun test`; the owner then runs the same plan by hand (#120). Every failure becomes a follow-up issue before cutover (§9.3).

Section references (§n.n) point into `docs/sharing-spec.md`. Capitalised terms are the glossary's (`CONTEXT.md`, Sharing): Shared, Standalone, Member, Video Editor, Unshared, Proposed, Elevate, Exposed, Repoint, Sync, Session record, Local copy, Unmounted, Not on this machine, Shelved.

**Never** point either test machine at the owner's real data dir (`~/Library/Application Support/TuvaVideos`) or real Root. The Player is exercised with sound off throughout.

---

## 1. Runbook: two test machines on one Mac

### 1.1 The three test accounts

`bun scripts/grant-video-access.ts <email> <level>` (§8.1) creates each account through the archive's `create-user` when it is new, inserts the grant, and prints how the temporary password is handled. The owner runs it; grants are never made from either app's UI. All three accounts are deleted at cutover (§9.1).

| Account | Email (the owner's address with a `+videotest` tag) | How it is made | Used on |
|---|---|---|---|
| Video Editor | `<owner>+videotest-editor@<domain>` | `bun scripts/grant-video-access.ts <owner>+videotest-editor@<domain> editor` | Machine A |
| Member | `<owner>+videotest-member@<domain>` | `bun scripts/grant-video-access.ts <owner>+videotest-member@<domain> member` | Machine B |
| No grant | `<owner>+videotest-nogrant@<domain>` | an archive account with **no** grant (created on songsofthesteppe.org, or by the script's account-creation half and its grant then removed) | Machine B, in the no-grant scenarios only |

The Admin scenarios (§5 of this plan) also need the test Video Editor to hold the archive moderator role for their length, set in the archive's console by the owner and removed afterwards; the admin steps use the owner's own admin account.

### 1.2 Seeded Shared content

`bun scripts/seed-shared.ts` (§9.1) runs against the live project, with the schema live and every `video_*` table otherwise empty. It:

- generates ffmpeg test clips (colour bars and tone, a few seconds) named `<title> [<fake 11-char id>].mp4`, some with `[instagram-…]` and `[rutube-…]` suffixes and some id-less, into the test Root it is given;
- writes matching Shared Videos pointing at real archive Songs, Versions and Artists (reads only), Chapters, Suggested rows, rejections, one soft-deleted Video, and Proposed Songs, Versions and Artists named `zz-test-…`;
- uploads their posters to the `posters` bucket;
- records every id it created, bucket objects included, in a manifest file. `bun scripts/seed-shared.ts --purge` deletes by manifest at the end of testing.

Record the manifest path and the seeded Video count in the results table (§8).

### 1.3 The machines

Two companions on this Mac, each with its own data dir, port and test Root. Ports other than the canonical 4400 keep each origin's supabase-js `localStorage` separate, so each signs in on its own (§5.3), and the owner's own library on 4400 is never started during testing.

| | Machine A | Machine B |
|---|---|---|
| `TUVA_DATA_DIR` | `~/TuvaTest/A/data` | `~/TuvaTest/B/data` |
| `TUVA_PORT` | `4401` | `4402` |
| Test Root | `~/TuvaTest/A/root` (the seed script's output) | `~/TuvaTest/B/root` (a subset of A's clips plus two of its own) |
| Account | test Video Editor | test Member (the no-grant account where a scenario says so) |
| Origin | `http://localhost:4401` | `http://localhost:4402` |
| TV Server | no | **yes**: the TV Server reads machine B's Local copy, on port `4403` (`TUVA_TV_PORT`) |

Setup, once:

1. `mkdir -p ~/TuvaTest/A/data ~/TuvaTest/A/root ~/TuvaTest/B/data ~/TuvaTest/B/root`.
2. `bun scripts/seed-shared.ts --root ~/TuvaTest/A/root` (with `--dry-run` first to read the plan). The script reads `TUVA_ARCHIVE_URL`, `TUVA_ARCHIVE_KEY`, `TUVA_SEED_EMAIL` and `TUVA_SEED_PASSWORD`; `bun --env-file=<file> scripts/seed-shared.ts …` loads them without exporting them into the shell.
3. Copy about half of the seeded clips into `~/TuvaTest/B/root`, including at least one YouTube-id, one Instagram, one Rutube and one id-less clip, so machine B has Videos both on and Not on this machine. Re-encode one of the YouTube-id clips (same name, different bytes) so its provenance matches and its hash does not. Add two clips the seed does not know, made with ffmpeg the same way: `zz-test unknown B1 [aaaaaaaaaa1].mp4` and the id-less `zz-test unknown B2.mp4`.
4. Start each machine from the worktree with its env vars: `TUVA_NO_OPEN=1 TUVA_DATA_DIR=~/TuvaTest/A/data TUVA_PORT=4401 bun run start`, and for B `TUVA_NO_OPEN=1 TUVA_DATA_DIR=~/TuvaTest/B/data TUVA_PORT=4402 TUVA_TV_PORT=4403 bun run start`. Both run at once. *(Amended in #120: the TV Server's default port is 4401, machine A's companion port, so B's TV Server must be moved; on macOS the wildcard bind succeeds silently beside A's `127.0.0.1:4401`, so nothing warns.)*
5. The TV Server lives in B's companion: the header's **TV** button (or `POST /api/tv/on`). Open `http://127.0.0.1:4403/` in a browser tab; it answers `{"error":"approve"}` until that client is approved from B's TV panel (or `POST /api/tv/approve {"ip":"127.0.0.1"}`).

Reset a machine between runs by stopping it and deleting its `data` directory; reset a Root by re-copying clips. Never `--purge` mid-run: both machines depend on the seeded Shared content.

### 1.4 Order of play

Standalone (§2) on a fresh B, then Member (§3) on B, then Video Editor (§4) on A with B re-Syncing to observe, then Admin (§5); TV Server (§6) is checked after the B Syncs it names. Scenarios inside a mode run in order; later steps assume earlier ones passed.

---

## 2. Standalone

Machine B, never signed in; later signed out, and signed in without the grant. Watch the Network panel: while Standalone no request goes to Supabase and Storage gets zero requests (§6.5).

| # | Action | Expected result | Checks |
|---|---|---|---|
| S1 | Start B on the fresh `~/TuvaTest/B/data`. | The first launch flow (Root field offered); a plain "Sign in" button at the header's right and nothing else; the app looks as before sharing. | §8.4, §2.2 |
| S2 | Add `~/TuvaTest/B/root` as a Root and scan. | All clips appear as Videos; none has `pending_share` set; every one is Unshared. No request to Supabase (REST or Storage). | §6.6, §6.5 |
| S3 | Tag locally a title, a Type, a Song and a Version pointer, an Artist and two Chapters on three Videos the seed also knows (one by YouTube id, one by Rutube id, one id-less one known by hash), and on `zz-test unknown B1`. Create one new Song while doing so. Star one of those Chapters and one Video as Favorites. | Writes land; the new Song is a `local_song` row. Favorites list shows both stars. | §6.1 |
| S4 | Play a Video for 20 s, stop, reopen. Use a clip of a minute or more (`ffmpeg -f lavfi -i testsrc=duration=60 …`): every seeded clip is under 30 s, and a position within 30 s of the end counts as finished and reopens at 0. *(Amended in #120.)* | Resume offered, as today. | §2.4 |
| S5 | Unmount the Root (rename the folder) and reload; rename it back. | Cards are Unmounted: dashed drive icon, "plug the drive in" overlay; auto-resume when the Root returns. | §7.1 |
| S6 | Look at the header. | No account chip, no Sync row, no Edits entry. | §2.2 |
| S7 | Look for the "On this machine" filter. | Shown: the chip hides only when it would select nothing (no Video with an Available Copy, #148), so on a Standalone machine with every Copy mounted it shows and selects everything; with the Root unmounted (S5) it is hidden. The `#available` search token still works. *(Amended in #120.)* | §7.2 |
| S8 | (After §3.1) Sign out on B from the Member session. | No confirmation; Session record cleared; chip back to "Sign in". The Local copy stays, read-only: Shared Videos listed with their Shared tags, no edit controls on them. Favorites, Resume, Copies, Roots, Thumbnails, Audio settings and Studio tracks untouched; Exposed Songs' text still readable. No purge. | §2.4 |
| S9 | Signed out, drop `zz-test unknown B3.mp4` into B's Root and scan. | An Unshared Video, taggable locally; nothing is sent. | §2.4, §6.6 |
| S10 | Signed out, scroll the whole grid. | Zero Storage requests; downloaded Shared posters show; others fall back to the locally generated poster, then the no-image card. | §6.5 |
| S11 | Sign in on B as the **no-grant** account. | Sign-in succeeds; avatar on the chip; the menu shows "No video library access" and one sentence saying to ask the owner; the grid stays as the last Sync left it, read-only. The machine is Standalone. No poster is downloaded. | §5.1, §2.1, §6.5 |
| S12 | As the no-grant account, press Sync. | The pull is refused (`42501`) and shown as the no-grant state, not a retry loop; grant level in the Session record stays none. | §6.2, §2.5 |
| S13 | Sign out; delete B's data dir; re-run S1-S3 on the fresh data dir before §3. | Same results: first launch and setup behave on a fresh data dir. | §8.4, §9.1 |

---

## 3. Member

Machine B, signed in as the test Member, holding the Standalone library of S13.

### 3.1 Sign-in and reconciliation

| # | Action | Expected result | Checks |
|---|---|---|---|
| M1 | Click "Sign in". | Dialog with email and password; no sign-up, no other provider; "Forgot password" links to songsofthesteppe.org. | §5.1 |
| M2 | Submit a wrong password. | One inline line, "Email or password is wrong"; never says which field was wrong. | §5.1 |
| M3 | Submit wrong passwords until rate-limited. | "Too many attempts, wait a minute". | §5.1 |
| M4 | Wi-Fi off, open the dialog; then Wi-Fi on. | "The archive can't be reached"; Submit disabled while unreachable. | §5.1 |
| M5 | Sign in with the Member's temporary password (`must_change_password` set). | Signs in; a notice with the songsofthesteppe.org link, the session stays; the app offers no password change. | §5.1 |
| M6 | Watch the step after credentials. | One `video_whoami()`; a confirmation counting what reconciliation will shelve (the three tagged known Videos of S3). | §5.1, §2.3 |
| M7 | Press Cancel on the confirmation. | Signs out (local scope); Session record cleared; chip "Sign in"; no half-signed-in state; local tags unchanged. | §2.3, §5.1 |
| M8 | Sign in again and confirm. | Sync runs (sign-in trigger, full refetch on the empty watermark). The three known Videos match by YouTube id, Rutube id and content hash and now carry the Shared title, Type, pointers, Artists and Chapters: **Shared wins**. The re-encoded clip joins its Shared Video as a new Copy. | §2.3, §6.4 |
| M9 | Open a reconciled Video. | A small Shelved marker; the drawer lists the old title, Type, pointers, Artists and Chapters, read-only; no "copy back" for a Member. | §2.3, §7.4 |
| M10 | Open Favorites. | The starred Chapter that was shelved has left the list; the Video Favorite is untouched. | §2.3 |
| M11 | Open B1 and `zz-test unknown B2`. Find B1 by the local title S3 gave it, not by its file name `zz-test unknown B1`. | Still Unshared with their local tags; the `local_song` of S3 stays local if B1 points at it, and is shelved if only reconciled Videos did. | §2.3, §6.6 |
| M12 | Inspect the network during sign-in. | No write of link data at all; nothing pushed for Videos the Shared set already knows. | §2.3 |
| M13 | Open the chip menu. | 34 px profile icon (avatar or initials) with the almond-tinted border; display name; Member role pill; "Last Sync …" with a Sync button; no "Share n new Videos…"; Edits; Sign out; Clear Shelved edits with the count. | §2.2 |

### 3.2 The grid as a Member

| # | Action | Expected result | Checks |
|---|---|---|---|
| M14 | Scroll the grid. | Every seeded Shared Video is listed; those with no clip in B's Root are **Not on this machine**: greyed poster, one small download mark, title and tags kept, no "n copies" or availability icons. The soft-deleted seeded Video is absent. | §7.1, §6.3 |
| M15 | Open a Not on this machine Video of each source kind. | A panel over the blurred poster: "Not on this machine", the message, and the source link (YouTube watch URL, Instagram post, `rutube.ru/video/<id>/`). Title, tags, Chapters, the history tab and the Lyrics drawer below as usual. | §7.1 |
| M16 | Copy that Video's clip from A's Root into B's Root and scan, with the Video open. | The panel gives way live; the Video becomes playable (no autoplay is expected). | §7.1 |
| M17 | Toggle "On this machine". | Now shown; Not on this machine Videos drop out; `#available` gives the same set. | §7.2 |
| M18 | Look for edit controls on a Shared Video. | `+ add`, Relocate, Delete from library, Rescan of Shared rows, confirm and reject are **hidden**. Trashing this machine's Copies, Favorites, Resume, Audio, Playlists and Studio still work. | §7.3, §2.5 |
| M19 | Tag an Unshared Video. | Allowed, locally. | §2.5 |
| M20 | Find a seeded Proposed `zz-test-…` Song, Version and Artist. | The Proposed mark wherever the name appears: grid tags, Now playing, search results, pickers. | §7.5 |
| M21 | (After A6) Open a Video pointing at the Exposed hidden Song. | Reads as any other Song, lyrics included; no Elevate or Expose controls. | §7.5 |
| M22 | Watch the chip during the first Sync. | Posters download in the second half of the Sync, 4 at a time, "posters n of m" in the chip; the grid stays usable; files land as `thumbs/<uuid>.poster.webp`. A Video with no `poster_path` keeps its locally generated poster. | §6.5 |

### 3.3 Sync triggers, failures and the schema gate

| # | Action | Expected result | Checks |
|---|---|---|---|
| M23 | Restart B's companion and reload the tab. | Grid and chip render at once from the Session record, no spinner; a Sync runs (launch trigger). | §5.3, §6.4 |
| M24 | Start B's companion with no tab open; wait 15 min. | No Sync happens. | §5.2 |
| M25 | Focus the window less than 10 min after a Sync; then again after 10 min. | First: no Sync. Second: the revocation probe (`getUser`), then a Sync. | §6.4, §5.3 |
| M26 | Leave the tab unfocused for 15 min. | No Sync and no probe: nothing runs on a timer. | §6.4, §5.3 |
| M27 | Press Sync twice quickly, and once in a second tab. | One Sync at a time; the extra request coalesces; the other tab re-reads `/api/session` and the watermark on focus. | §5.3 |
| M28 | Inspect a `/api/sync` call and the companion log. | The call carries the access token only, never the refresh token; the log shows no token. The same call with a foreign Origin or Host is refused. | §5.2 |
| M29 | Kill the network mid-Sync. | Rollback; watermark unchanged; the chip's Sync row shows the error in one line; Sync backs off and retries. | §6.2 |
| M30 | Client behind: lower `SHARED_SCHEMA` in the checkout (local edit, reverted after), restart, Sync. | Sync stops; a persistent banner above the grid, "Update TuvaVideos: git pull, then restart"; browsing and playback continue from the Local copy. | §6.4 |
| M31 | Client ahead: raise it instead, restart, Sync; then revert and Sync. | Sync stops with a banner naming the mismatch; the reverted client's next successful Sync clears it. | §6.4 |
| M32 | Feed `/api/cache/apply` a batch with a different `shared_schema`. | Refused whole; nothing applied. | §6.2 |
| M33 | Chip menu, "Refresh all Shared data" (one confirm: "Re-download all Shared data from the archive? Your local tags and Favorites are kept."). | A full refetch; the Local copy matches the pre-refetch state; watermark is the server's. | §6.4, §6.2 |

### 3.4 Member offline

| # | Action | Expected result | Checks |
|---|---|---|---|
| MO1 | Wi-Fi off; reload B. | The grid renders as the Member view from the Session record (supabase-js reports a null session; the record decides). The chip shows the slashed dot; the Sync row says the archive cannot be reached. | §5.3, §2.2 |
| MO2 | Stay offline for hours (or move the clock forward a day). | No cap, no idle timeout, no sign-out. | §5.3 |
| MO3 | Offline, scan a new clip into B's Root. | An Unshared Video, playable and taggable. | §6.6 |
| MO4 | Offline, play, set Favorites and Resume. | All work. | §7.3 |
| MO5 | Wi-Fi on; do nothing; then focus the window. | No Sync on network return; on focus, probe then Sync if the last one is older than 10 min. | §6.4 |
| MO6 | Open B on `http://127.0.0.1:4402` (an origin with no stored session). | Chip says "Sign in"; the grid stays the Member view, read-only; the Session record is left alone. | §5.3 |

### 3.5 Dropped sessions

| # | Action | Expected result | Checks |
|---|---|---|---|
| MD1 | Owner revokes the Member's sessions in the archive console; focus B. | Chip reverts to "Sign in"; dismissable banner "Your session ended. Sign in again."; Session record cleared; everything else kept, read-only. | §5.4 |
| MD2 | Sign in again. | Normal reconciliation: a no-op confirmation, or one counting only Unshared Videos scanned meanwhile (MO3). | §5.4 |
| MD3 | Check Dashboard, Auth, Sessions. | Session time-box and inactivity limit both off; record it in §8. | §5.3 |

---

## 4. Video Editor

Machine A, signed in as the test Video Editor; machine B (Member) Syncs to observe. Steps citing §4.x check behaviour specified in the write model.

### 4.1 Sign-in, scans and `pending_share`

| # | Action | Expected result | Checks |
|---|---|---|---|
| E1 | Start A on its fresh data dir; first launch; add `~/TuvaTest/A/root`; scan **before** signing in; tag two seeded Videos locally. | All seeded clips appear as Unshared Videos. | §8.4, §6.6 |
| E2 | Add `zz-test unknown A1 [aaaaaaaaaa2].mp4` and the id-less `zz-test unknown A2.mp4`; scan; tag A1 with a new local Song. | Unshared. | §6.6 |
| E3 | Sign in as the Video Editor; confirm reconciliation. | Seeded clips reconcile to their Shared Videos (Shared wins, the two tagged ones get Shelved edits); the two unknown clips enter the `pending_share` queue; Editor role pill. | §2.3, §6.6 |
| E4 | After the first Sync of the session. | Asked once: "Share 2 new Videos from <folder>?", with how many have no YouTube id, Instagram shortcode or Rutube id (here 1). Never mid-scan. | §6.6 |
| E5 | Decline. | The queue waits; both stay Unshared; chip row "Share 2 new Videos…" present. | §6.6, §2.2 |
| E6 | Open "Share 2 new Videos…" and Share. | Drained through `write_videos`, one call per Video with defaults and Chapters, Proposed rows first; A1's local Song becomes a Proposed Song; `/api/cache/apply` clears the flag. B, after its Sync, lists both as Not on this machine. | §6.6, §2.3, §4.3 |
| E7 | Scan in a third unknown clip. | Drained automatically, no question. | §6.6 |
| E8 | Offline, scan in a fourth unknown clip; then go online and Sync. | Queued, playable and taggable, no question offline; drained at the Sync. | §6.6 |
| E9 | Open a Shelved drawer; "copy back" a Shelved Chapter (the starred kind) and a pointer. | Ordinary writes with history; the Chapter is re-starred; B shows them after its Sync. | §7.4, §2.3 |
| E10 | "Clear" one Video's drawer; then "Clear Shelved edits" from the chip menu. | Per-Video clear; the chip entry shows the count and asks one confirmation. | §2.3, §7.4 |

### 4.2 Writes, conflicts, undo, soft delete, Repoint

| # | Action | Expected result | Checks |
|---|---|---|---|
| E11 | Edit a Shared Video's title, Type, Song pointer and an Artist; add a Chapter. | Applied to the Local copy in the same step, then a Sync (own-write trigger); listed under Edits; B shows it after its Sync. | §6.4, §4.8 |
| E12 | Create a Proposed Song, Version and Artist (`zz-test-…`) and point a Chapter at them. | The Proposed mark everywhere on A, and on B after its Sync. | §7.5, §4.3 |
| E13 | Conflict: edit the same Video's title in two A tabs, saving the second after the first. | The second save takes the conflict path (no silent overwrite), with a one-line error. | §4.2 |
| E14 | Edit a Video on A while a Sync applies an older row of it. | The older incoming row is skipped; A's write survives. | §6.2 |
| E15 | Undo E11 from Edits. | Reverted, with history; B reverts after its Sync. | §4.7 |
| E16 | Delete from library a Shared Video. | Soft delete: it leaves A's grid and B's after Sync; no Video tombstone. | §4.5, §6.3 |
| E17 | Undo the soft delete. | The Video returns on both. | §4.5, §4.7 |
| E18 | Delete a Proposed Artist nothing points at. | A `shared_tombstone` row (`deleted`); B drops it after its Sync. | §6.3 |
| E19 | Repoint every link from one seeded Artist to another. | Every Video moves; logged per Video; nothing deleted in the archive; B follows. | §4.6 |
| E20 | Undo the Repoint. | Links restored per Video. | §4.6, §4.7 |
| E21 | Owner lowers the grant to member mid-session; write on A. | The write fails; the grant is re-read at once; edit controls on Shared Videos go away; Unshared Videos stay taggable; no local fork. Owner restores the grant; next Sync restores the controls. | §2.5, §6.2 |
| E22 | Offline, open a Shared Video; then online with a throttled network, during the first 2.5 s after load. | Edit controls shown but **disabled with a notice** in both cases. | §2.5, §5.3, §7.3 |

### 4.3 Posters both ways

| # | Action | Expected result | Checks |
|---|---|---|---|
| E23 | The Videos shared in E6-E8 have local posters and no `poster_path`. | After the scan and at each Sync the browser uploads them, 4 at a time (`image/webp`, `cacheControl: '31536000'`, `upsert: false`) to `<video uuid>/<sha256 prefix>.webp`; `write_videos` sets `poster_path`; then `/api/cache/apply`. The companion uploads nothing. | §6.5 |
| E24 | On B, Sync. | B downloads them; `poster_hash` recorded; the Shared poster replaces B's locally generated one. | §6.5 |
| E25 | Give a Shared Video a new local poster on A and let it upload. | A new object at a new path; B re-downloads because the hash differs. | §6.5 |
| E26 | From the consoles, try a non-webp upload or a path outside `^<uuid>/[0-9a-f]{8,64}\.webp$` as the editor, and any upload as the Member. | All refused by the bucket and Storage RLS. | §6.5 |

---

## 5. Admin (editor + moderator, and the archive admin)

The test Video Editor holds the archive moderator role for A1-A4; A6-A8 use the owner's own admin account. Machine A unless stated.

| # | Action | Expected result | Checks |
|---|---|---|---|
| A1 | As editor + moderator, open a Proposed `zz-test-…` Song. | The Elevate control on the Song, where its archive actions would be; absent on B. | §7.5, §4.4 |
| A2 | Elevate it (once, by hand). | It becomes an archive row with the same id, hidden and Exposed; every Video and Chapter repointed in the same step; tombstone `elevated`; on B after Sync it carries no Proposed mark. | §4.4, §6.3, §9.1 |
| A3 | Check songsofthesteppe.org. | The elevated Song is not visible there. | §9.1 |
| A4 | Owner, as admin, deletes the elevated `zz-test` Song in the archive. | The next Sync on A and B drops it through the ids-only reconcile (`archive_ids`). | §6.3, §9.1 |
| A5 | Remove the moderator role from the test Video Editor; reload. | Elevate control gone. | §7.5 |
| A6 | Owner Exposes one real hidden Song a seeded Video points at. | The Expose control only for the admin; after Sync, B reads the Song and its lyrics as any other Song (M21); the lyrics website is unchanged. | §7.5, §9.1 |
| A7 | Unexpose it. | After Sync it leaves both Local copies (out of the caller's RLS view). | §6.3, §9.1 |
| A8 | Look through both apps for grant controls. | None; grants only through `bun scripts/grant-video-access.ts` and the console. | §8.1 |

---

## 6. TV Server

The TV Server reads machine B's Local copy (§1.3).

| # | Action | Expected result | Checks |
|---|---|---|---|
| T1 | Open the TV after M8. | Reads the Local copy unchanged; lists show B's Shared Videos with Shared titles and tags. | §7.6 |
| T2 | Compare the TV lists with B's grid. | Not on this machine Videos excluded; Unmounted ones kept as today. | §7.6, §7.1 |
| T3 | After M16. | The Video copied in appears on the TV. | §7.6 |
| T4 | Run B's companion with no browser tab; use the TV. | Works from the last Sync's copy; no Sync happens. | §5.2 |
| T5 | After S8 (B signed out). | The TV keeps working on the read-only Local copy. | §2.4, §7.6 |
| T6 | During MO6. | The TV still sees a Member. | §5.3 |
| T7 | After E11 and a B Sync, play that Video on the TV. | New tags shown; playback unaffected. | §7.6 |

---

## 7. Cleanup

1. `bun scripts/seed-shared.ts --purge` (by manifest, posters included).
2. Stop both companions and the TV Server; delete `~/TuvaTest`.
3. Revert any local `SHARED_SCHEMA` edit (M30-M31); remove the test moderator role if A5 was skipped.
4. The three `+videotest` accounts stay until cutover, then are deleted (§9.1).

---

## 8. Results (#120)

### Agent pass, 2026-10-18

Run by: Opus build agent (Claude Opus 5.5) Date: 2026-10-18 Commit: `265f33d` (main `7498201` plus the seed fix) Seed manifest: `~/TuvaTest/A/root/zz-test-seed.manifest.json` Seeded Videos: 11 (10 live, 1 soft-deleted), with 5 Chapters, 9 Artist links, 2 each of Proposed Songs, Versions and Artists, 11 posters
Session time-box and inactivity limit off (MD3): not checked (owner)

Accounts: the plan's `+videotest` addresses were replaced by `test1@test.com` (Video Editor, grant `editor`, archive moderator), `test2@test.com` (Member, grant `member`) and `test3@test.com` (no grant). `bun test` 890 pass, 0 fail; `tsc --noEmit` clean.

13 Pass, 0 Fail, 83 left for the owner. The agent did not sign in to the archive from either app: entering an account password into a page that sends it to the live Supabase project is outside what it may do, so every scenario that needs a session is the owner's. The seed itself ran (the owner's script, credentials from the env file).

| Scenario | Pass / Fail | Notes | Follow-up issue |
|---|---|---|---|
| S1 | Pass | Fresh B: Root panel and Sign in card (§8.4's two calls to action); the header holds only "Sign in". | |
| S2 | Pass | 7 clips (5 seeded, B1, B2) scanned; `pending_share` 0 and `shared` 0 on every Video; no request left localhost (Performance entries, companion log). | |
| S3 | Pass | Title, Type, Song, Artist and two Chapters on Хоомей (UI) and on the Rutube clip, the id-less one and B1 (the same routes from the page); the new Song is a `local_song`; Favorites lists the Video and the Chapter. No Version pointer: a never-signed-in machine has no Versions to pick (`archive_version` empty; a local Song has none). | |
| S4 | Pass | Seeded clips are 3-8 s, always "finished"; used a 60 s clip (`zz-test long B4.mp4`): paused at 21 s, reopened at 21 s. Plan amended. | |
| S5 | Pass | Root renamed: cards carry the dashed drive (`avail none`), the Player shows "Copy unavailable … Plug the drive in"; renamed back, playback resumed by itself within the 3 s poll. | |
| S6 | Pass | Only "Sign in"; no chip, Sync row or Edits. | |
| S7 | Pass | Chip shown with every Copy mounted (hidden only when it would select nothing, #148) and hidden while the Root was unmounted. Plan amended (it said hidden). | |
| S8 | Owner | Needs the Member session of §3.1. Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| S9 | Pass | Run before any sign-in: `zz-test unknown B3.mp4` scanned in as Unshared (`pending_share` 0), taggable, nothing sent. Repeat after S8 for the signed-out-with-Local-copy case. | |
| S10 | Owner | Needs downloaded Shared posters (after a Member Sync). Before any sign-in the grid made zero non-local requests. Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| S11 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| S12 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| S13 | Pass | B stopped, data dir deleted, restarted: onboarding `standalone`/panel, Root saved through `POST /api/roots`, S3's tags and Favorites re-applied; 9 Videos, all Unshared, one `local_song`. B is left in this state for §3. | |
| M1 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M2 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M3 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M4 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M5 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M6 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M7 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M8 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M9 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M10 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M11 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M12 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M13 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M14 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M15 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M16 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M17 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M18 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M19 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M20 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M21 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M22 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M23 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M24 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M25 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M26 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M27 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M28 | Owner | Refusal half passed: `POST /api/sync` with a foreign Origin 403, with a foreign Host 403 ("Host is not this machine"). Token half needs a session. Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M29 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M30 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M31 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| M32 | Pass | `POST /api/cache/apply` with `shared_schema: 999`: 422 "nothing was applied: the batch is Shared schema 999, this checkout speaks 1". | |
| M33 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| MO1 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| MO2 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| MO3 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| MO4 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| MO5 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| MO6 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| MD1 | Owner | Archive console action plus a B session. | |
| MD2 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| MD3 | Owner | Dashboard check (Auth, Sessions). | |
| E1 | Pass | Fresh A: panel, Root added, all 11 seeded clips (the soft-deleted one too) appear as Unshared; two tagged locally. | |
| E2 | Pass | A1 and A2 scanned in after the first scan, Unshared; A1 points at a new `local_song`. | |
| E3 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E4 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E5 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E6 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E7 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E8 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E9 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E10 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E11 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E12 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E13 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E14 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E15 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E16 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E17 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E18 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E19 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E20 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E21 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E22 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E23 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E24 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E25 | Owner | Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| E26 | Owner | From the consoles as each account. Checked here: the bucket is private (`/storage/v1/object/public/posters/<seeded object>` answers "Bucket not found"); the seed's 11 `image/webp` uploads went in as the editor. | |
| A1 | Owner | Needs the editor+moderator session on A. Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| A2 | Owner | Needs the editor+moderator session on A. Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| A3 | Owner | After A2. | |
| A4 | Owner | Needs the owner's admin account. | |
| A5 | Owner | Needs the editor+moderator session on A. Owner: needs a browser sign-in to the live archive, which the agent may not do (no credential entry outside a local host). | |
| A6 | Owner | Needs the owner's admin account. | |
| A7 | Owner | Needs the owner's admin account. | |
| A8 | Pass | No grant control exists in either app's code: nothing in `src/` writes `video_access` (only the read `video_access_profile_ids`); the never-signed-in UI on A and B has none. Re-check once signed in. | |
| T1 | Owner | Follows the Member scenarios it names. Checked here: B's TV Server (port 4403) serves the Standalone Local copy at `http://127.0.0.1:4403/` once 127.0.0.1 is approved: Favorites, Library 9, Artists, local tags shown. | |
| T2 | Owner | Follows the Member scenarios it names. Checked here: B's TV Server (port 4403) serves the Standalone Local copy at `http://127.0.0.1:4403/` once 127.0.0.1 is approved: Favorites, Library 9, Artists, local tags shown. | |
| T3 | Owner | Follows the Member scenarios it names. Checked here: B's TV Server (port 4403) serves the Standalone Local copy at `http://127.0.0.1:4403/` once 127.0.0.1 is approved: Favorites, Library 9, Artists, local tags shown. | |
| T4 | Owner | Follows the Member scenarios it names. Checked here: B's TV Server (port 4403) serves the Standalone Local copy at `http://127.0.0.1:4403/` once 127.0.0.1 is approved: Favorites, Library 9, Artists, local tags shown. | |
| T5 | Owner | Follows the Member scenarios it names. Checked here: B's TV Server (port 4403) serves the Standalone Local copy at `http://127.0.0.1:4403/` once 127.0.0.1 is approved: Favorites, Library 9, Artists, local tags shown. | |
| T6 | Owner | Follows the Member scenarios it names. Checked here: B's TV Server (port 4403) serves the Standalone Local copy at `http://127.0.0.1:4403/` once 127.0.0.1 is approved: Favorites, Library 9, Artists, local tags shown. | |
| T7 | Owner | Follows the Member scenarios it names. Checked here: B's TV Server (port 4403) serves the Standalone Local copy at `http://127.0.0.1:4403/` once 127.0.0.1 is approved: Favorites, Library 9, Artists, local tags shown. | |

### Fixed on the branch

- `scripts/seed-shared.ts` read `song_lyrics.label`, which the live archive does not have (the column is `version_label`); the seed stopped at its first read. Now `label:version_label` (`265f33d`). Spec §3.1's `video_proposed_versions` row amended to say so.
- This plan: §1.3 B's TV Server on `TUVA_TV_PORT=4403` (its default 4401 is machine A's companion port) and how to approve a browser tab; S4 needs a clip over 30 s; S7's expected result follows #148.

### Follow-up issues

None opened: no app defect was found in the scenarios the agent could run.
