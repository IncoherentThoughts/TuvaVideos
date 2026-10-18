#!/usr/bin/env bun
// Seeded Shared content for testing the sharing build (docs/sharing-spec.md §9.1, ticket #132). Never the owner's data.
//
//   bun scripts/seed-shared.ts --root <test Root> [--manifest <file>]          seed: clips, Shared rows, posters
//   bun scripts/seed-shared.ts --root <test Root> --dry-run                    print the plan, write nothing
//   bun scripts/seed-shared.ts --root <test Root> --clips-only                 only generate the clips (no network)
//   bun scripts/seed-shared.ts --purge <manifest> [--dry-run]                  delete everything a seed created
//   bun scripts/seed-shared.ts --delete-test-accounts <email,email,…> [--dry-run]
//
// Seed: ffmpeg writes eleven colour-bars-and-tone clips (3–8 s, mp4/mkv/webm; YouTube-id'd, `[instagram-…]`,
// `[rutube-<32 hex>]` and id-less) into `<root>/zz-test-seed/`, then, signed in as a test Video Editor, the script
// reads real archive Songs, Versions and Artists (read only) and writes Shared rows through the write functions only
// (§4.1): `zz-test-…` Proposed Artists/Songs/Versions, one Video per clip with Chapters, Suggested rows and Latin
// titles, a confirmed and a rejected Suggested Chapter, a rejected Suggested Artist, a poster per Video in the
// `posters` bucket, and one soft-deleted Video. Every row id and bucket object goes into the manifest (written after
// each step, so a failed run is still purgeable). Purge deletes by manifest with the service-role key, removes the
// clips, and verifies every `video_*` table (but `video_access`) and the bucket are empty.
//
// Environment: TUVA_ARCHIVE_URL, TUVA_ARCHIVE_KEY (publishable key), TUVA_SEED_EMAIL (or --email) and
// TUVA_SEED_PASSWORD for the test Video Editor; TUVA_ARCHIVE_SERVICE_KEY for --purge and --delete-test-accounts.
// --dry-run without TUVA_ARCHIVE_URL plans against test/fixtures/seed-archive.json.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readArchiveError, type WriteResult } from "../src/shared/archiveWire";
import type { SharedVideoArtistRow } from "../src/shared/sharedRows";
import {
  buildSeedPlan, emptyManifest, ffmpegArgs, formatPlan, parseManifest, planIsComplete, posterPath, PURGE_ORDER, recordResult,
  SEED_DIR, seedClips, serializeManifest, VERIFY_EMPTY, type ArchiveSnapshot, type RpcStep, type SeedManifest, type SeedPlan,
} from "./seed/plan";

// ---------------------------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------------------------

export interface SeedArgs {
  mode: "seed" | "clips-only" | "purge" | "delete-test-accounts";
  dryRun: boolean;
  root: string | null;
  manifest: string | null;
  email: string | null;
  accounts: string[];
}

export function parseArgs(argv: string[], env: Record<string, string | undefined> = {}): SeedArgs {
  const valueOf = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    if (i < 0) return null;
    const v = argv[i + 1];
    if (v == null || v.startsWith("--")) throw new Error(`--${n} needs a value`);
    return v;
  };
  const known = new Set(["--root", "--manifest", "--email", "--purge", "--delete-test-accounts", "--dry-run", "--clips-only"]);
  for (const a of argv) if (a.startsWith("--") && !known.has(a)) throw new Error(`unknown flag ${a}`);
  const purge = valueOf("purge");
  const accounts = valueOf("delete-test-accounts");
  const clipsOnly = argv.includes("--clips-only");
  if ([purge != null, accounts != null, clipsOnly].filter(Boolean).length > 1) throw new Error("--purge, --delete-test-accounts and --clips-only are exclusive");
  const mode = purge != null ? "purge" : accounts != null ? "delete-test-accounts" : clipsOnly ? "clips-only" : "seed";
  const root = valueOf("root");
  if ((mode === "seed" || mode === "clips-only") && !root) throw new Error("--root <test Root> is required");
  return {
    mode, dryRun: argv.includes("--dry-run"), root: root ? resolve(root) : null,
    manifest: purge ?? valueOf("manifest") ?? (root ? join(resolve(root), `${SEED_DIR}.manifest.json`) : null),
    email: valueOf("email") ?? env.TUVA_SEED_EMAIL ?? null,
    accounts: accounts ? accounts.split(",").map((s) => s.trim()).filter(Boolean) : [],
  };
}

/** Refuses the owner's data dir (and anything under it) as a test Root. */
export function assertTestRoot(root: string, home = homedir()): void {
  const owner = resolve(home, "Library/Application Support/TuvaVideos");
  const r = resolve(root);
  if (r === owner || r.startsWith(owner + "/")) throw new Error(`refusing the owner's data dir as a test Root: ${r}`);
  if (r === resolve(home) || r === "/") throw new Error(`refusing ${r} as a test Root`);
}

/** Only clearly test-named accounts may be deleted. */
export function assertTestEmail(email: string): void {
  if (!/test/i.test(email.split("@")[0] ?? "")) throw new Error(`refusing to delete an account that is not test-named: ${email}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Clips and posters (ffmpeg, cwebp)
// ---------------------------------------------------------------------------------------------------------------

const which = (name: string) => (existsSync(`/usr/local/bin/${name}`) ? `/usr/local/bin/${name}` : (Bun.which(name) ?? name));
const FFMPEG = which("ffmpeg");
const CWEBP = which("cwebp");

async function run(cmd: string[]): Promise<void> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`${cmd[0]} exited ${code}: ${err.trim().slice(0, 500)}`);
}

async function sha256(path: string): Promise<string> {
  return new Bun.CryptoHasher("sha256").update(await Bun.file(path).arrayBuffer()).digest("hex");
}

/** Writes the clips that are not on disk yet; returns file -> sha256 for all of them. */
async function generateClips(root: string, log: (s: string) => void): Promise<{ hashes: Record<string, string>; paths: string[] }> {
  const dir = join(root, SEED_DIR);
  mkdirSync(dir, { recursive: true });
  const hashes: Record<string, string> = {};
  const paths: string[] = [];
  for (const c of seedClips()) {
    const out = join(dir, c.file);
    if (!existsSync(out)) await run([FFMPEG, ...ffmpegArgs(c, out)]);
    hashes[c.file] = await sha256(out);
    paths.push(out);
    log(`clip ${out}  sha256 ${hashes[c.file]!.slice(0, 16)}…`);
  }
  return { hashes, paths };
}

function existingHashes(root: string): Promise<Record<string, string>> {
  return (async () => {
    const out: Record<string, string> = {};
    for (const c of seedClips()) {
      const p = join(root, SEED_DIR, c.file);
      if (existsSync(p)) out[c.file] = await sha256(p);
    }
    return out;
  })();
}

async function makePoster(clip: string): Promise<{ bytes: Uint8Array; sha: string }> {
  const tmp = mkdtempSync(join(tmpdir(), "tuva-seed-poster-"));
  try {
    const png = join(tmp, "p.png"), webp = join(tmp, "p.webp");
    await run([FFMPEG, "-hide_banner", "-loglevel", "error", "-y", "-ss", "1", "-i", clip, "-frames:v", "1", "-vf", "scale=320:-2", png]);
    await run([CWEBP, "-quiet", "-q", "70", png, "-o", webp]);
    const bytes = new Uint8Array(await Bun.file(webp).arrayBuffer());
    return { bytes, sha: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The archive over HTTP (PostgREST, Auth, Storage, Functions); no supabase-js in the companion
// ---------------------------------------------------------------------------------------------------------------

interface Conn {
  url: string;
  key: string;
  /** Bearer: the editor's access token, or the service-role key. */
  bearer: string;
}

async function call(c: Conn, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(`${c.url}${path}`, {
    method,
    headers: { apikey: c.key, authorization: `Bearer ${c.bearer}`, ...(body !== undefined && !(body instanceof Uint8Array) ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? new Blob([body as Uint8Array<ArrayBuffer>]) : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!res.ok) {
    const e = json && typeof json === "object" ? (json as Record<string, string>) : { message: String(json) };
    const ae = readArchiveError(e);
    throw new Error(`${method} ${path} -> ${res.status} ${ae.word}${ae.code ? ` (${ae.code})` : ""}: ${ae.message || text.slice(0, 300)}${e.details ? ` ${e.details}` : ""}`);
  }
  return json;
}

async function signIn(url: string, key: string, email: string, password: string): Promise<{ conn: Conn; userId: string }> {
  const r = (await call({ url, key, bearer: key }, "POST", "/auth/v1/token?grant_type=password", { email, password })) as { access_token: string; user: { id: string } };
  return { conn: { url, key, bearer: r.access_token }, userId: r.user.id };
}

async function readArchive(c: Conn): Promise<ArchiveSnapshot> {
  const get = (q: string) => call(c, "GET", `/rest/v1/${q}`) as Promise<never>;
  const [songs, versions, artists] = await Promise.all([
    get("songs?select=id,name&order=id&limit=300"),
    get("song_lyrics?select=id,song_id,label:version_label&order=id&limit=1000"),
    get("artists?select=id,name&order=id&limit=300"),
  ]);
  return { songs, versions, artists };
}

// ---------------------------------------------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------------------------------------------

function fixtureArchive(): ArchiveSnapshot {
  return JSON.parse(readFileSync(join(import.meta.dir, "..", "test", "fixtures", "seed-archive.json"), "utf8"));
}

const say = (s: string) => console.log(s);
const need = (env: Record<string, string | undefined>, n: string) => {
  const v = env[n];
  if (!v) throw new Error(`${n} is not set`);
  return v.replace(/\/+$/, "");
};

async function seed(a: SeedArgs, env: Record<string, string | undefined>): Promise<void> {
  const root = a.root!;
  assertTestRoot(root);
  if (a.mode === "clips-only") {
    await generateClips(root, say);
    return;
  }
  if (a.dryRun) {
    const live = env.TUVA_ARCHIVE_URL && env.TUVA_ARCHIVE_KEY;
    let archive: ArchiveSnapshot;
    if (live && a.email && env.TUVA_SEED_PASSWORD) archive = await readArchive((await signIn(need(env, "TUVA_ARCHIVE_URL"), env.TUVA_ARCHIVE_KEY!, a.email, env.TUVA_SEED_PASSWORD)).conn);
    else if (live) archive = await readArchive({ url: need(env, "TUVA_ARCHIVE_URL"), key: env.TUVA_ARCHIVE_KEY!, bearer: env.TUVA_ARCHIVE_KEY! });
    else archive = fixtureArchive();
    say(`dry run: archive rows from ${live ? env.TUVA_ARCHIVE_URL : "test/fixtures/seed-archive.json"}; nothing is written`);
    const plan = buildSeedPlan(archive, await existingHashes(root), () => crypto.randomUUID());
    say(formatPlan(plan));
    say(`manifest would be ${a.manifest}`);
    if (!planIsComplete(plan)) say("note: id-less clips are not on disk yet, so their content_hash shows as pending-sha256");
    return;
  }

  const url = need(env, "TUVA_ARCHIVE_URL");
  const key = need(env, "TUVA_ARCHIVE_KEY");
  if (!a.email) throw new Error("--email or TUVA_SEED_EMAIL is required");
  const password = need(env, "TUVA_SEED_PASSWORD");
  const manifestPath = a.manifest!;
  if (existsSync(manifestPath) && parseManifest(readFileSync(manifestPath, "utf8")).purged_at == null)
    throw new Error(`${manifestPath} holds an unpurged seed; run --purge ${manifestPath} first`);

  const { conn, userId } = await signIn(url, key, a.email, password);
  const who = (await call(conn, "POST", "/rest/v1/rpc/video_whoami", {})) as { grant_level: string | null; shared_schema: number };
  if (who.grant_level !== "editor") throw new Error(`${a.email} is not a Video Editor (grant_level ${who.grant_level})`);

  const { hashes, paths } = await generateClips(root, say);
  const plan = buildSeedPlan(await readArchive(conn), hashes, () => crypto.randomUUID());
  if (!planIsComplete(plan)) throw new Error("plan has pending content hashes");

  const m = emptyManifest({ archive_url: url, editor_id: userId, root, now: new Date().toISOString() });
  m.clips = paths;
  const save = () => writeFileSync(manifestPath, serializeManifest(m));
  save();
  await execute(plan, conn, m, save, join(root, SEED_DIR));
  m.completed_at = new Date().toISOString();
  save();
  say(`seeded: ${PURGE_ORDER.map((t) => `${t} ${m.rows[t].length}`).join(", ")}, posters ${m.posters.length}`);
  say(`manifest ${manifestPath}; undo with: bun scripts/seed-shared.ts --purge ${JSON.stringify(manifestPath)}`);
}

async function execute(plan: SeedPlan, conn: Conn, m: SeedManifest, save: () => void, clipDir: string): Promise<void> {
  const stamps = new Map<string, string>();
  const links: SharedVideoArtistRow[] = [];
  const rpc = async (fn: string, args: Record<string, unknown>): Promise<WriteResult> => {
    const r = (await call(conn, "POST", `/rest/v1/rpc/${fn}`, args)) as WriteResult;
    recordResult(m, r);
    save();
    for (const rows of Object.values(r.tables ?? {})) for (const row of (rows ?? []) as { id: string; updated_at?: string }[]) if (row.updated_at) stamps.set(row.id, row.updated_at);
    for (const l of r.tables?.video_artists ?? []) {
      const i = links.findIndex((x) => x.id === l.id);
      if (i >= 0) links[i] = l;
      else links.push(l);
    }
    return r;
  };
  const resolveTarget = (s: RpcStep): string | null => {
    if (s.target == null || typeof s.target === "string") return s.target;
    const q = s.target.link;
    const l = links.find((x) => x.video_id === q.video_id && (q.artist_id ? x.artist_id === q.artist_id : x.proposed_artist_id === q.proposed_artist_id));
    if (!l) throw new Error(`${s.label}: no such Artist link in the results so far`);
    return l.id;
  };
  for (const [i, s] of plan.steps.entries()) {
    say(`${String(i + 1).padStart(2)}/${plan.steps.length} ${s.label}`);
    if (s.kind === "poster") {
      const { bytes, sha } = await makePoster(join(clipDir, s.clip));
      const path = posterPath(s.video_id, sha);
      await call(conn, "POST", `/storage/v1/object/posters/${path}`, bytes, { "content-type": "image/webp", "cache-control": "max-age=31536000", "x-upsert": "false" });
      m.posters.push(path);
      save();
      await rpc("write_videos", {
        p_op: "update", p_target: s.video_id, p_payload: { poster_path: path }, p_expected_updated_at: stamps.get(s.video_id) ?? null,
        p_edits: [{ event_type: "video.poster_changed", field_name: "poster_path", old_value: null, new_value: path, description: "zz-test seed: poster" }],
      });
      continue;
    }
    const stamp = s.stampOf ? stamps.get(s.stampOf) : null;
    if (s.stampOf && !stamp) throw new Error(`${s.label}: no updated_at known for ${s.stampOf}`);
    await rpc(s.fn, { p_op: s.op, p_target: resolveTarget(s), p_payload: s.payload, p_expected_updated_at: stamp ?? null, p_edits: s.edits });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Purge and test accounts (service-role key)
// ---------------------------------------------------------------------------------------------------------------

async function purge(a: SeedArgs, env: Record<string, string | undefined>): Promise<void> {
  const path = a.manifest!;
  const m = parseManifest(readFileSync(path, "utf8"));
  say(`purge ${path}: ${PURGE_ORDER.map((t) => `${t} ${m.rows[t].length}`).join(", ")}, posters ${m.posters.length}, clips ${m.clips.length}`);
  if (a.dryRun) {
    for (const t of PURGE_ORDER) if (m.rows[t].length) say(`  DELETE ${t} id in (${m.rows[t].join(", ")})`);
    for (const p of m.posters) say(`  remove posters/${p}`);
    for (const c of m.clips) say(`  rm ${c}`);
    return;
  }
  const url = need(env, "TUVA_ARCHIVE_URL");
  if (url !== m.archive_url.replace(/\/+$/, "")) throw new Error(`manifest is for ${m.archive_url}, TUVA_ARCHIVE_URL is ${url}`);
  const service = need(env, "TUVA_ARCHIVE_SERVICE_KEY");
  const conn: Conn = { url, key: service, bearer: service };
  // History rows of the seeded Videos that the results did not carry (trigger-written) go with their Video id.
  const vids = m.rows.videos;
  for (let i = 0; i < vids.length; i += 50) await call(conn, "DELETE", `/rest/v1/video_edit_history?video_id=in.(${vids.slice(i, i + 50).join(",")})`, undefined, { prefer: "return=minimal" });
  for (const t of PURGE_ORDER) {
    const ids = m.rows[t];
    for (let i = 0; i < ids.length; i += 50) await call(conn, "DELETE", `/rest/v1/${t}?id=in.(${ids.slice(i, i + 50).join(",")})`, undefined, { prefer: "return=minimal" });
  }
  if (m.posters.length) await call(conn, "DELETE", "/storage/v1/object/posters", { prefixes: m.posters });
  for (const c of m.clips) if (existsSync(c)) rmSync(c);
  const left: string[] = [];
  for (const t of VERIFY_EMPTY) {
    const rows = (await call(conn, "GET", `/rest/v1/${t}?select=id&limit=5`)) as { id: string }[];
    if (rows.length) left.push(`${t}: ${rows.map((r) => r.id).join(", ")}${rows.length === 5 ? ", …" : ""}`);
  }
  const objects = (await call(conn, "POST", "/storage/v1/object/list/posters", { prefix: "", limit: 5 })) as { name: string }[];
  if (objects.length) left.push(`posters bucket: ${objects.map((o) => o.name).join(", ")}`);
  m.purged_at = new Date().toISOString();
  writeFileSync(path, serializeManifest(m));
  if (left.length) {
    console.error(`purged the manifest's rows, but these are not empty:\n  ${left.join("\n  ")}`);
    process.exit(1);
  }
  say("purged; every video_* table (but video_access) and the posters bucket are empty");
}

async function deleteTestAccounts(a: SeedArgs, env: Record<string, string | undefined>): Promise<void> {
  if (!a.accounts.length) throw new Error("--delete-test-accounts needs a comma-separated list of emails");
  for (const e of a.accounts) assertTestEmail(e);
  if (a.dryRun) {
    for (const e of a.accounts) say(`would delete ${e} through functions/v1/delete-user`);
    return;
  }
  const url = need(env, "TUVA_ARCHIVE_URL");
  const service = need(env, "TUVA_ARCHIVE_SERVICE_KEY");
  const conn: Conn = { url, key: service, bearer: service };
  const { users } = (await call(conn, "GET", "/auth/v1/admin/users?page=1&per_page=1000")) as { users: { id: string; email: string | null }[] };
  for (const e of a.accounts) {
    const u = users.find((x) => x.email?.toLowerCase() === e.toLowerCase());
    if (!u) {
      say(`${e}: no such account, skipped`);
      continue;
    }
    await call(conn, "POST", "/functions/v1/delete-user", { userId: u.id });
    say(`${e}: deleted (${u.id})`);
  }
}

export async function main(argv: string[], env: Record<string, string | undefined>): Promise<void> {
  const a = parseArgs(argv, env);
  if (a.mode === "purge") return purge(a, env);
  if (a.mode === "delete-test-accounts") return deleteTestAccounts(a, env);
  return seed(a, env);
}

if (import.meta.main) {
  main(process.argv.slice(2), process.env).catch((e) => {
    console.error(`seed-shared: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
