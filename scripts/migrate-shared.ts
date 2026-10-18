#!/usr/bin/env bun
// The one-time migration of the owner's link data into the archive (docs/sharing-spec.md §9.2, ticket #113). Run once
// at cutover (§9.3), after archive migration 130 is live and the seed is purged:
//
//   TUVA_ARCHIVE_URL=https://<ref>.supabase.co TUVA_ARCHIVE_KEY=<publishable key> \
//   TUVA_ARCHIVE_SERVICE_KEY=<service-role key> TUVA_MIGRATE_AS=<owner's archive email> \
//   bun scripts/migrate-shared.ts [--dry-run] [--accept "<name>"]...
//
// It reads library.db from the data dir (TUVA_DATA_DIR honoured) through a migrated temporary copy, so the owner's
// file is never written. It refuses, printing the list, while the §9.2 rows are unresolved (re-counted every run);
// refuses unless every `video_*` table and the `posters` bucket are empty (or hold only what an interrupted run of
// this script wrote, recorded by the resume marker `<data dir>/migrate-shared.state.json`); then writes, through the
// write functions as the owner: Proposed Songs -> Versions -> Artists, the Videos with Chapters and Artist links
// (posters uploaded first), the deletions; the rejections and the library's `created_at` with the service-role key;
// prints the exposure list and exposes it after a y/n. `--dry-run` prints every count and refusal and writes nothing.
// A failed run is re-run as is: the marker lets it start on its own rows, and it skips what the target already holds.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { loadConfig } from "../src/server/config";
import { openDb } from "../src/server/db";
import { buildPlan, hasRefusals, preflight, reconcile, MAPPED_ARTIST, type Plan, type PosterFile, type Refusals, type ResumeState, type TargetRows } from "../src/server/migrateShared/plan";
import { Archive, ArchiveCallError } from "../src/server/migrateShared/remote";
import { findPoster, readSnapshot } from "../src/server/migrateShared/snapshot";

const SHARED_TABLES = [
  "videos", "video_chapters", "video_artists", "video_chapter_rejections", "video_artist_rejections",
  "video_proposed_songs", "video_proposed_versions", "video_proposed_artists", "video_exposed_songs", "video_edit_history",
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const accept: string[] = [];
for (let i = 0; i < args.length; i++) if (args[i] === "--accept" && args[i + 1]) accept.push(args[++i]!);

const cfg = loadConfig();
const env = process.env;
const statePath = join(cfg.dataDir, "migrate-shared.state.json");

function readLibrary() {
  if (!existsSync(cfg.dbPath)) throw new Error(`no library.db at ${cfg.dbPath}`);
  const dir = mkdtempSync(join(tmpdir(), "tuva-migrate-"));
  try {
    const copy = join(dir, "library.db");
    copyFileSync(cfg.dbPath, copy);
    if (existsSync(`${cfg.dbPath}-wal`)) copyFileSync(`${cfg.dbPath}-wal`, `${copy}-wal`);
    const db = openDb(copy, join(import.meta.dir, "..", "migrations"));
    try {
      return readSnapshot(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function printRefusals(r: Refusals) {
  const section = <T>(title: string, rows: T[], line: (x: T) => string) => {
    console.log(`\n${title}: ${rows.length}`);
    for (const x of rows) console.log(`  - ${line(x)}`);
  };
  section("Near-duplicates (#87) to resolve: rename, merge or delete in the app, or --accept \"<name>\" after review", r.nearDuplicates, (d) => `${d.kind} "${d.name}" (${d.id}): ${d.why}`);
  section("Working-note Version labels to tidy", r.workingNoteLabels, (v) => `"${v.label}" on ${v.song} (${v.id})`);
  section("Unreferenced Local Songs (point a Video at them, or delete them)", r.unreferencedSongs, (s) => `"${s.name}" (${s.id}), ${s.versions} Version(s)`);
  section("Pointers the archive's foreign keys would refuse", r.pointerMismatches, (p) => `${p.table} ${p.id}: ${p.why}`);
}

function printPlan(plan: Plan) {
  console.log("\nCounts:");
  for (const [k, v] of Object.entries(plan.counts)) console.log(`  ${k.padEnd(24)} ${v}`);
  console.log(`\nDropped (not carried):`);
  for (const s of plan.dropped.songs) console.log(`  - Song "${s.name}": ${s.why}`);
  for (const a of plan.dropped.artists) console.log(`  - Artist "${a.name}": ${a.why}`);
  for (const d of plan.dropped.deletedVideos) console.log(`  - deleted_video ${d.id} "${d.title}": ${d.why}`);
  for (const p of plan.dropped.posters) console.log(`  - poster of ${p.id}: ${p.why}`);
  console.log(`\nExposure list: ${plan.exposure.length} hidden Songs, ${plan.counts.exposure_videos} Videos`);
  for (const e of plan.exposure) console.log(`  - ${e.name} (${e.songId}): ${e.videos} Video(s)${e.chapters ? `, ${e.chapters} Chapter(s)` : ""}`);
}

async function main() {
  console.log(`migrate-shared${dryRun ? " --dry-run" : ""}: library ${cfg.dbPath}`);
  const snap = readLibrary();
  const refusals = preflight(snap, { accept });
  printRefusals(refusals);

  const url = env.TUVA_ARCHIVE_URL;
  const publishableKey = env.TUVA_ARCHIVE_KEY;
  const archive = url && publishableKey ? new Archive({ url: url.replace(/\/$/, ""), publishableKey, serviceKey: env.TUVA_ARCHIVE_SERVICE_KEY ?? null }) : null;

  // The live archive row of Andrei Mongush, read by name with the publishable key.
  let mappedArtistId: string | null = null;
  const blockers: string[] = [];
  if (archive) {
    const rows = await archive.artistsNamed(MAPPED_ARTIST);
    if (rows.length === 1) mappedArtistId = rows[0]!.id;
    else blockers.push(`${rows.length} archive Artists are named "${MAPPED_ARTIST}" (need exactly 1)`);
    console.log(`\nArchive Artist "${MAPPED_ARTIST}": ${mappedArtistId ?? "not found"}`);
  } else {
    blockers.push("TUVA_ARCHIVE_URL and TUVA_ARCHIVE_KEY are not set: Andrei Mongush unresolved, the target unchecked");
  }

  const posters = new Map<string, PosterFile>();
  for (const v of snap.videos) {
    const p = findPoster(cfg.thumbsDir, v);
    if (p) posters.set(v.id, p);
  }
  const plan = buildPlan(snap, { mappedArtistId, posters });
  printPlan(plan);

  // The target: empty, or holding only this script's rows under a resume marker.
  const resume: ResumeState | null = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : null;
  let done = new Set<string>();
  let half = new Set<string>();
  if (archive?.env.serviceKey) {
    const counts = Object.fromEntries(await Promise.all(SHARED_TABLES.map(async (t) => [t, await archive.count(t)] as const)));
    const objects = await archive.posterObjects(1);
    const busy = Object.entries(counts).filter(([, n]) => n > 0);
    console.log(`\nTarget: ${busy.length ? busy.map(([t, n]) => `${t} ${n}`).join(", ") : "every video_* table empty"}; posters bucket ${objects ? "not empty" : "empty"}`);
    if ((busy.length || objects) && !resume) blockers.push("the target is not empty and there is no resume marker: purge the seed first (§9.2)");
    if (resume) {
      const target: TargetRows = {
        videos: await archive.all("videos", "id,deleted_at"),
        video_proposed_songs: (await archive.all<{ id: string }>("video_proposed_songs", "id")).map((r) => r.id),
        video_proposed_versions: (await archive.all<{ id: string }>("video_proposed_versions", "id")).map((r) => r.id),
        video_proposed_artists: (await archive.all<{ id: string }>("video_proposed_artists", "id")).map((r) => r.id),
      };
      const r = reconcile(plan, target);
      if (r.foreign.length) blockers.push(`the target holds ${r.foreign.length} rows this run did not plan (e.g. ${r.foreign.slice(0, 3).join(", ")})`);
      ({ done, half } = r);
      console.log(`Resuming the run started ${resume.started_at}: ${done.size} writes already done, ${half.size} deletion(s) half done`);
    }
  } else {
    blockers.push("TUVA_ARCHIVE_SERVICE_KEY is not set: the target is unchecked");
  }

  const refused = hasRefusals(refusals);
  if (dryRun) {
    console.log(`\nDry run: nothing written. ${refused ? "The run would refuse on the lists above." : "No library refusals."}`);
    for (const b of blockers) console.log(`  - blocked: ${b}`);
    return;
  }
  if (refused || blockers.length) {
    console.error("\nRefusing to migrate:");
    if (refused) console.error("  - library.db has unresolved rows (listed above)");
    for (const b of blockers) console.error(`  - ${b}`);
    process.exit(1);
  }

  const email = env.TUVA_MIGRATE_AS;
  if (!email) throw new Error("TUVA_MIGRATE_AS (the owner's archive email) is not set");
  const a = archive!;
  await a.signInAs(email);
  const me = await a.whoami();
  if (me.grant_level !== "editor" || me.archive_role !== "admin") throw new Error(`${email} must hold the editor grant and the archive admin role (has ${me.grant_level}, ${me.archive_role})`);
  if (!resume) writeFileSync(statePath, JSON.stringify({ started_at: new Date().toISOString(), planned: plan.steps.length } satisfies ResumeState, null, 2));

  // 1. The writes, one function call each, in plan order.
  let n = 0;
  for (const s of plan.steps) {
    n++;
    if (done.has(s.key)) continue;
    if (n % 100 === 0) console.log(`  ${n}/${plan.steps.length}`);
    try {
      switch (s.kind) {
        case "proposed_song": await a.write("write_proposed_songs", "create", s.id, s.payload, s.edits); break;
        case "proposed_version": await a.write("write_proposed_versions", "create", s.id, s.payload, s.edits); break;
        case "proposed_artist": await a.write("write_proposed_artists", "create", s.id, s.payload, s.edits); break;
        case "video":
          if (s.poster) await a.uploadPoster(s.poster.path, readFileSync(s.poster.file));
          await a.write("write_videos", "insert", s.id, s.payload, s.edits);
          break;
        case "deleted_video": {
          let stamp: string | null = null;
          if (!half.has(s.key)) {
            const out = await a.write("write_videos", "insert", s.id, s.payload, s.edits);
            stamp = String(out.tables.videos?.find((r) => r.id === s.id)?.updated_at ?? "");
          } else {
            stamp = await a.updatedAt("videos", s.id);
          }
          await a.write("write_videos", "delete", s.id, { reason: s.reason }, s.deleteEdits, stamp);
          break;
        }
      }
    } catch (e) {
      console.error(`\nFailed at ${s.key} ("${"title" in s ? s.title : "name" in s.payload ? s.payload.name : s.payload.label}"): ${e instanceof Error ? e.message : e}`);
      if (e instanceof ArchiveCallError && e.error.word === "duplicate-candidate") console.error(`  candidates: ${JSON.stringify(e.error.detail)}`);
      console.error(`Fix the cause and run the script again: it resumes from ${statePath}.`);
      process.exit(1);
    }
  }

  // 2. Rejections and the library's created_at, with the service-role key (no write function takes either).
  await a.insertIgnoringDuplicates("video_chapter_rejections", plan.chapterRejections.map((r) => ({ ...r, created_at: r.created_at ?? undefined, created_by: me.user_id })));
  await a.insertIgnoringDuplicates("video_artist_rejections", plan.artistRejections.map((r) => ({ ...r, created_at: r.created_at ?? undefined, created_by: me.user_id })));
  await a.mergeColumns("videos", plan.createdAt);
  console.log(`\nCarried ${plan.counts.videos} Videos, ${plan.counts.deletions} deletions, ${plan.counts.proposed_songs + plan.counts.proposed_versions + plan.counts.proposed_artists} Proposed rows, ${plan.chapterRejections.length + plan.artistRejections.length} rejections.`);

  // 3. Exposure, after the owner confirms the list printed above.
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`\nExpose the ${plan.exposure.length} hidden Songs listed above to Members? [y/n] `)).trim().toLowerCase();
  rl.close();
  if (answer === "y" || answer === "yes") {
    for (const e of plan.exposure) {
      await a.write("set_song_exposure", "expose", e.songId, {}, [{ event_type: "exposure.exposed", description: `Initial exposure list of the one-time migration (#113): ${e.videos} Video(s)` }]);
    }
    console.log(`Exposed ${plan.exposure.length} Songs.`);
  } else {
    console.log("Not exposed. Expose them later from the app (admin), Song by Song.");
  }
  rmSync(statePath, { force: true });
  console.log("Done.");
}

await main();
