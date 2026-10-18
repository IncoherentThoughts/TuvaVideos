// The pure half of `bun scripts/seed-shared.ts` (docs/sharing-spec.md §9.1, ticket #132): the test clips' names and
// ffmpeg arguments, the Shared-row plan built from a snapshot of archive rows (Songs, Versions, Artists, read only),
// and the manifest that records every id and bucket object a seed run created so `--purge` can delete it all.
// No I/O here; the script does the network, ffmpeg and files.
import type { EditInput, WriteFunction, WriteResult } from "../../src/shared/archiveWire";

// ---------------------------------------------------------------------------------------------------------------
// Archive snapshot (what the seed points at; read through the publishable client)
// ---------------------------------------------------------------------------------------------------------------

export interface ArchiveSnapshot {
  songs: { id: string; name: string }[];
  /** `song_lyrics` rows: a Version of an archive Song. */
  versions: { id: string; song_id: string; label: string | null }[];
  artists: { id: string; name: string }[];
}

/** The archive rows the plan uses: three Songs that each have a Version, and two Artists, picked deterministically. */
export interface ArchivePicks {
  songs: { id: string; name: string; version_id: string }[];
  artists: { id: string; name: string }[];
}

const isTestName = (n: string) => /^zz-test/i.test(n.trim());

export function pickArchiveRows(a: ArchiveSnapshot): ArchivePicks {
  const byId = <T extends { id: string }>(xs: T[]) => [...xs].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const firstVersion = new Map<string, string>();
  for (const v of byId(a.versions)) if (!firstVersion.has(v.song_id)) firstVersion.set(v.song_id, v.id);
  const songs = byId(a.songs)
    .filter((s) => firstVersion.has(s.id) && !isTestName(s.name))
    .slice(0, 3)
    .map((s) => ({ id: s.id, name: s.name, version_id: firstVersion.get(s.id)! }));
  const artists = byId(a.artists).filter((x) => !isTestName(x.name)).slice(0, 2);
  if (songs.length < 3) throw new Error(`seed needs 3 archive Songs with a Version; the archive gave ${songs.length}`);
  if (artists.length < 2) throw new Error(`seed needs 2 archive Artists; the archive gave ${artists.length}`);
  return { songs, artists };
}

// ---------------------------------------------------------------------------------------------------------------
// Clips
// ---------------------------------------------------------------------------------------------------------------

export type ClipExt = "mp4" | "mkv" | "webm";

export interface ClipSpec {
  /** Stable key the plan refers to (`c01` …). */
  key: string;
  /** The Video title, which is also the filename stem before the id suffix. */
  title: string;
  /** A Latin title for Cyrillic ones, or null. */
  titleLatin: string | null;
  ext: ClipExt;
  durationS: number;
  youtubeId: string | null;
  instagramId: string | null;
  rutubeId: string | null;
  /** The file name inside the seed folder. */
  file: string;
}

/** The folder under the test Root the clips go into. */
export const SEED_DIR = "zz-test-seed";
/** Marks a content hash the dry-run could not compute (no clip on disk); a live run refuses a plan holding it. */
export const PENDING_HASH = "pending-sha256";

/** An 11-character fake YouTube id, `zzTest` + 5 digits: matches the scan's `[A-Za-z0-9_-]{11}` and no real id. */
export function fakeYoutubeId(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 99999) throw new Error(`fake id out of range: ${n}`);
  return `zzTest${String(n).padStart(5, "0")}`;
}

/** A fake Rutube id: 32 lower-case hex, deterministic, starting `7e57` ("test"). */
export function fakeRutubeId(n: number): string {
  const h = new Bun.CryptoHasher("sha256").update(`zz-test-rutube-${n}`).digest("hex");
  return `7e57${h.slice(0, 28)}`;
}

/** `<title> [<id>].ext`, `<title> [instagram-<code>].ext`, `<title> [rutube-<hex>].ext`, or `<title>.ext`. */
export function clipFileName(c: Pick<ClipSpec, "title" | "ext" | "youtubeId" | "instagramId" | "rutubeId">): string {
  const ids = [c.youtubeId, c.instagramId, c.rutubeId].filter((x) => x != null);
  if (ids.length > 1) throw new Error(`a clip carries one id at most: ${c.title}`);
  if (/[\/\[\]]/.test(c.title)) throw new Error(`clip title must not contain / [ ]: ${c.title}`);
  const suffix = c.youtubeId ? ` [${c.youtubeId}]` : c.instagramId ? ` [instagram-${c.instagramId}]` : c.rutubeId ? ` [rutube-${c.rutubeId}]` : "";
  return `${c.title}${suffix}.${c.ext}`;
}

function clip(key: string, title: string, titleLatin: string | null, ext: ClipExt, durationS: number, id: Partial<Pick<ClipSpec, "youtubeId" | "instagramId" | "rutubeId">>): ClipSpec {
  const base = { key, title, titleLatin, ext, durationS, youtubeId: id.youtubeId ?? null, instagramId: id.instagramId ?? null, rutubeId: id.rutubeId ?? null };
  return { ...base, file: clipFileName(base) };
}

/** The eleven seed clips: YouTube-id'd (mp4/mkv/webm), Instagram, Rutube and id-less, 3–8 s each. */
export function seedClips(): ClipSpec[] {
  return [
    clip("c01", "Хоомей тест", "Khoomei test", "mp4", 6, { youtubeId: fakeYoutubeId(1) }),
    clip("c02", "zz-test Concert", null, "mkv", 8, { youtubeId: fakeYoutubeId(2) }),
    clip("c03", "Сыгыт тест", "Sygyt test", "webm", 5, { youtubeId: fakeYoutubeId(3) }),
    clip("c04", "zz-test Interview", null, "mp4", 4, { youtubeId: fakeYoutubeId(4) }),
    clip("c05", "Instagram video", null, "mp4", 3, { instagramId: "zzTestIG001" }),
    clip("c06", "zz-test Reel", null, "mp4", 4, { instagramId: "zzTestIG002" }),
    clip("c07", "Каргыраа тест", "Kargyraa test", "mp4", 7, { rutubeId: fakeRutubeId(1) }),
    clip("c08", "zz-test Rutube Other", null, "mkv", 3, { rutubeId: fakeRutubeId(2) }),
    clip("c09", "zz-test No Id Song", null, "webm", 5, {}),
    clip("c10", "zz-test No Id Other", null, "mp4", 3, {}),
    clip("c11", "zz-test Deleted", null, "mp4", 3, { youtubeId: fakeYoutubeId(11) }),
  ];
}

/** ffmpeg arguments for one clip: colour bars + a sine tone, bit-exact so a regeneration hashes the same on one machine. */
export function ffmpegArgs(c: ClipSpec, out: string): string[] {
  const freq = 220 + 110 * Number(c.key.slice(1));
  const codecs =
    c.ext === "webm"
      ? ["-c:v", "libvpx-vp9", "-b:v", "200k", "-deadline", "realtime", "-c:a", "libopus", "-b:a", "48k"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k"];
  return [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", `smptebars=size=320x180:rate=25:duration=${c.durationS}`,
    "-f", "lavfi", "-i", `sine=frequency=${freq}:sample_rate=48000:duration=${c.durationS}`,
    ...codecs,
    "-shortest", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
    out,
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------------------------

/** A step's target: a literal uuid, or a Video's Artist link found in an earlier result (links are server-keyed). */
export type TargetRef = string | { link: { video_id: string; artist_id?: string; proposed_artist_id?: string } };

export interface RpcStep {
  kind: "rpc";
  label: string;
  fn: WriteFunction;
  op: string;
  target: TargetRef | null;
  payload: Record<string, unknown>;
  /** The row whose latest known `updated_at` goes in `p_expected_updated_at`, or null for none. */
  stampOf: string | null;
  edits: EditInput[];
}

/** Grab a frame of the clip, encode webp, upload `<video uuid>/<sha256 prefix>.webp`, then `write_videos update poster_path`. */
export interface PosterStep {
  kind: "poster";
  label: string;
  video_id: string;
  clip: string;
}

export type SeedStep = RpcStep | PosterStep;

export interface SeedPlan {
  clips: ClipSpec[];
  picks: ArchivePicks;
  steps: SeedStep[];
}

const edit = (event_type: EditInput["event_type"], description: string, extra: Partial<EditInput> = {}): EditInput[] => [
  { event_type, description: `zz-test seed: ${description}`, ...extra },
];

/**
 * The whole seed as an ordered list of write-function calls (call shapes of sharing-spec §4.1): Proposed Artists,
 * Songs and Versions named `zz-test-…`; one Video per clip pointing at real archive Songs/Versions/Artists and at the
 * Proposed rows, with Chapters, Suggested rows and Latin titles; a confirmed and a rejected Suggested Chapter, a
 * rejected Suggested Artist; a poster for every Video; one Video soft-deleted. `hashes` maps clip file -> sha256
 * (a missing one becomes PENDING_HASH); `mint` makes uuids (the client mints them, §3).
 */
export function buildSeedPlan(archive: ArchiveSnapshot, hashes: Record<string, string | undefined>, mint: () => string): SeedPlan {
  const picks = pickArchiveRows(archive);
  const [r0, r1, r2] = picks.songs as [ArchivePicks["songs"][number], ArchivePicks["songs"][number], ArchivePicks["songs"][number]];
  const [a0, a1] = picks.artists as [ArchivePicks["artists"][number], ArchivePicks["artists"][number]];
  const clips = seedClips();
  const steps: SeedStep[] = [];
  const rpc = (s: Omit<RpcStep, "kind">) => steps.push({ kind: "rpc", ...s });

  // Proposed rows (force: the seed's names never need the dedupe prompt)
  const pa1 = mint(), pa2 = mint(), ps1 = mint(), ps2 = mint(), pv1 = mint(), pv2 = mint();
  rpc({ label: "Proposed Artist zz-test-artist Ensemble", fn: "write_proposed_artists", op: "create", target: pa1, payload: { name: "zz-test-artist Ensemble", force: true }, stampOf: null, edits: edit("proposed.artist_created", "Proposed Artist") });
  rpc({ label: "Proposed Artist zz-test-artist Solo", fn: "write_proposed_artists", op: "create", target: pa2, payload: { name: "zz-test-artist Solo", force: true }, stampOf: null, edits: edit("proposed.artist_created", "Proposed Artist") });
  rpc({ label: "Proposed Song zz-test-song Хоомей", fn: "write_proposed_songs", op: "create", target: ps1, payload: { name: "zz-test-song Хоомей", english_name: "zz-test-song Khoomei", alternate_titles: null, notes: "seed-shared.ts", force: true }, stampOf: null, edits: edit("proposed.song_created", "Proposed Song") });
  rpc({ label: "Proposed Song zz-test-song Second", fn: "write_proposed_songs", op: "create", target: ps2, payload: { name: "zz-test-song Second", english_name: null, alternate_titles: null, notes: "seed-shared.ts", force: true }, stampOf: null, edits: edit("proposed.song_created", "Proposed Song") });
  rpc({ label: "Proposed Version under Proposed Song", fn: "write_proposed_versions", op: "create", target: pv1, payload: { proposed_song_id: ps1, label: "zz-test-version 1", lyrics_cyrillic: "Тест тест", lyrics_transliteration: "Test test", lyrics_translation: "Test test", source: "seed-shared.ts", footnotes_cyrillic: [], footnotes_transliteration: [], footnotes_translation: [], force: true }, stampOf: null, edits: edit("proposed.version_created", "Proposed Version") });
  rpc({ label: `Proposed Version under archive Song ${r0.name}`, fn: "write_proposed_versions", op: "create", target: pv2, payload: { song_id: r0.id, label: "zz-test-version on archive Song", lyrics_cyrillic: null, lyrics_transliteration: null, lyrics_translation: null, source: "seed-shared.ts", footnotes_cyrillic: [], footnotes_transliteration: [], footnotes_translation: [], force: true }, stampOf: null, edits: edit("proposed.version_created", "Proposed Version") });

  const vid: Record<string, string> = {};
  for (const c of clips) vid[c.key] = mint();
  const ch = (start_s: number, title: string, rest: Record<string, unknown> = {}) => ({
    id: mint(), start_s, title, title_latin: null, song_id: null, proposed_song_id: null, version_id: null, proposed_version_id: null, suggested: false, source: "manual", ...rest,
  });
  const c2Suggested = ch(4, "zz-test suggested (comment)", { song_id: r2.id, suggested: true, source: "comment" });
  const c2ToConfirm = ch(6, "zz-test suggested (description)", { song_id: r1.id, version_id: r1.version_id, suggested: true, source: "description" });

  const videoCols: Record<string, Record<string, unknown>> = {
    c01: { type: "song", song_id: r0.id, version_id: r0.version_id, title_latin: "Khoomei test", title_latin_source: "manual", chapters: [ch(0, "Начало", { title_latin: "Nachalo", song_id: r0.id, version_id: r0.version_id })], artists: [{ artist_id: a0.id, suggested: false }] },
    c02: {
      type: "concert",
      chapters: [ch(0, "zz-test opening", { song_id: r0.id }), ch(2, "zz-test Proposed Song", { proposed_song_id: ps1, proposed_version_id: pv1 }), c2Suggested, c2ToConfirm],
      artists: [{ artist_id: a0.id, suggested: false }, { proposed_artist_id: pa1, suggested: false }, { artist_id: a1.id, suggested: true }],
    },
    c03: { type: "song", type_suggested: true, song_id: r1.id, song_suggested: true, suggestion_source: "title", title_latin: "Sygyt test", title_latin_source: "table", artists: [{ artist_id: a1.id, suggested: true }, { proposed_artist_id: pa2, suggested: true }] },
    c04: { type: "interview", artists: [{ proposed_artist_id: pa2, suggested: false }] },
    c05: { type: "song", song_id: r2.id, version_id: r2.version_id },
    c06: { type: "other" },
    c07: { type: "song", proposed_song_id: ps1, proposed_version_id: pv1, title_latin: "Kargyraa test", title_latin_source: "manual", artists: [{ proposed_artist_id: pa1, suggested: false }] },
    c08: { type: "song", proposed_song_id: ps2 },
    c09: { type: "song", song_id: r0.id, proposed_version_id: pv2, artists: [{ artist_id: a0.id, suggested: false }] },
    c10: { type: "other", type_suggested: true },
    c11: { type: "song", song_id: r1.id },
  };

  for (const c of clips) {
    const hash = hashes[c.file] ?? (c.youtubeId ? undefined : PENDING_HASH);
    rpc({
      label: `Video ${c.file}`, fn: "write_videos", op: "insert", target: vid[c.key]!,
      payload: { title: c.title, youtube_id: c.youtubeId, instagram_id: c.instagramId, rutube_id: c.rutubeId, content_hash: hash ?? null, ...videoCols[c.key] },
      stampOf: null, edits: edit("video.scanned", `Video ${c.title}`),
    });
  }

  // Suggested rows acted on: one confirmed, one rejected Chapter; one rejected Artist link
  rpc({ label: "confirm Suggested Chapter on c02", fn: "write_video_chapters", op: "confirm", target: c2ToConfirm.id, payload: {}, stampOf: c2ToConfirm.id, edits: edit("chapter.confirmed", "confirm Suggested Chapter") });
  rpc({ label: "reject Suggested Chapter on c02", fn: "write_video_chapters", op: "reject", target: c2Suggested.id, payload: {}, stampOf: c2Suggested.id, edits: edit("chapter.rejected", "reject Suggested Chapter") });
  rpc({ label: "reject Suggested Artist on c03", fn: "write_video_artists", op: "reject", target: { link: { video_id: vid.c03!, artist_id: a1.id } }, payload: {}, stampOf: null, edits: edit("artist_link.rejected", "reject Suggested Artist") });

  for (const c of clips) steps.push({ kind: "poster", label: `poster ${c.file}`, video_id: vid[c.key]!, clip: c.file });

  rpc({ label: "soft-delete c11", fn: "write_videos", op: "delete", target: vid.c11!, payload: { reason: "zz-test seed: soft-deleted Video" }, stampOf: vid.c11!, edits: edit("video.deleted", "soft delete") });

  return { clips, picks, steps };
}

/** True when a plan can be executed (every id-less Video has a real content hash). */
export function planIsComplete(p: SeedPlan): boolean {
  return p.steps.every((s) => s.kind !== "rpc" || s.payload.content_hash !== PENDING_HASH);
}

/** The plan as the `--dry-run` prints it. */
export function formatPlan(p: SeedPlan): string {
  const lines = [
    `archive Songs used: ${p.picks.songs.map((s) => `${s.name} (${s.id}, Version ${s.version_id})`).join("; ")}`,
    `archive Artists used: ${p.picks.artists.map((a) => `${a.name} (${a.id})`).join("; ")}`,
    `clips (${p.clips.length}) into <root>/${SEED_DIR}/:`,
    ...p.clips.map((c) => `  ${c.file}  ${c.durationS}s`),
    `steps (${p.steps.length}):`,
  ];
  p.steps.forEach((s, i) => {
    const n = String(i + 1).padStart(2, " ");
    if (s.kind === "poster") lines.push(`  ${n}. upload posters/${s.video_id}/<sha256>.webp, write_videos update poster_path  (${s.clip})`);
    else {
      const target = s.target == null ? "null" : typeof s.target === "string" ? s.target : `link(${s.target.link.video_id} -> ${s.target.link.artist_id ?? s.target.link.proposed_artist_id})`;
      lines.push(`  ${n}. ${s.fn} ${s.op} ${target}${s.stampOf ? " [stamp]" : ""}  ${s.label}`);
      lines.push(`      payload ${JSON.stringify(s.payload)}`);
    }
  });
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------------------------------

/** The Shared tables a seed run creates rows in, in the order `--purge` deletes them (children first). */
export const PURGE_ORDER = [
  "video_edit_history",
  "video_chapter_rejections",
  "video_artist_rejections",
  "video_chapters",
  "video_artists",
  "videos",
  "video_proposed_versions",
  "video_proposed_songs",
  "video_proposed_artists",
  "shared_tombstone",
] as const;
export type SeedTable = (typeof PURGE_ORDER)[number];

export interface SeedManifest {
  kind: "tuva-seed-shared";
  version: 1;
  created_at: string;
  archive_url: string;
  editor_id: string | null;
  root: string;
  /** Absolute paths of the clip files the run wrote. */
  clips: string[];
  rows: Record<SeedTable, string[]>;
  /** Object paths in the `posters` bucket. */
  posters: string[];
  /** Set when every step ran. */
  completed_at: string | null;
  purged_at: string | null;
}

export function emptyManifest(o: { archive_url: string; editor_id: string | null; root: string; now: string }): SeedManifest {
  return {
    kind: "tuva-seed-shared", version: 1, created_at: o.now, archive_url: o.archive_url, editor_id: o.editor_id, root: o.root,
    clips: [], rows: Object.fromEntries(PURGE_ORDER.map((t) => [t, []])) as unknown as Record<SeedTable, string[]>,
    posters: [], completed_at: null, purged_at: null,
  };
}

const addUnique = (xs: string[], x: string) => {
  if (!xs.includes(x)) xs.push(x);
};

/** Records every Shared row id in a write result (Video bundles, history rows, tombstones). Archive tables are not ours. */
export function recordResult(m: SeedManifest, r: WriteResult): SeedManifest {
  for (const t of PURGE_ORDER) {
    if (t === "shared_tombstone") continue;
    for (const row of (r.tables as Record<string, { id: string }[] | undefined>)[t] ?? []) addUnique(m.rows[t], row.id);
  }
  for (const tb of r.tombstones ?? []) addUnique(m.rows.shared_tombstone, tb.id);
  return m;
}

export function serializeManifest(m: SeedManifest): string {
  return JSON.stringify(m, null, 2) + "\n";
}

export function parseManifest(text: string): SeedManifest {
  const m = JSON.parse(text) as Partial<SeedManifest>;
  if (m.kind !== "tuva-seed-shared" || m.version !== 1) throw new Error("not a seed-shared manifest (kind/version)");
  const strs = (x: unknown, what: string): string[] => {
    if (!Array.isArray(x) || x.some((s) => typeof s !== "string")) throw new Error(`manifest ${what} must be a string array`);
    return x as string[];
  };
  const rows = {} as Record<SeedTable, string[]>;
  for (const t of PURGE_ORDER) rows[t] = strs(m.rows?.[t] ?? [], `rows.${t}`);
  for (const id of Object.values(rows).flat()) if (!UUID.test(id)) throw new Error(`manifest row id is not a uuid: ${id}`);
  const posters = strs(m.posters, "posters");
  for (const p of posters) if (!POSTER_PATH.test(p)) throw new Error(`manifest poster path is malformed: ${p}`);
  if (typeof m.archive_url !== "string" || typeof m.root !== "string" || typeof m.created_at !== "string") throw new Error("manifest lacks archive_url/root/created_at");
  return {
    kind: "tuva-seed-shared", version: 1, created_at: m.created_at, archive_url: m.archive_url, editor_id: m.editor_id ?? null, root: m.root,
    clips: strs(m.clips, "clips"), rows, posters, completed_at: m.completed_at ?? null, purged_at: m.purged_at ?? null,
  };
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The bucket's INSERT check (§6.5): `<uuid>/<8–64 hex>.webp`. */
export const POSTER_PATH = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8,64}\.webp$/;

export function posterPath(videoId: string, sha256Hex: string): string {
  const p = `${videoId}/${sha256Hex.slice(0, 16)}.webp`;
  if (!POSTER_PATH.test(p)) throw new Error(`bad poster path ${p}`);
  return p;
}

/** The `video_*` tables `--purge` checks are empty afterwards (all of 130's but the console-only grant table). */
export const VERIFY_EMPTY = [
  "videos", "video_chapters", "video_artists", "video_chapter_rejections", "video_artist_rejections",
  "video_proposed_songs", "video_proposed_versions", "video_proposed_artists", "video_exposed_songs", "video_edit_history",
] as const;
