// The one-time migration of the owner's link data into the archive (docs/sharing-spec.md §9.2, ticket #113): the
// preflight over `library.db` and the plan of every write, both pure. `snapshot.ts` reads a Local copy into a
// `LibrarySnapshot`; `scripts/migrate-shared.ts` runs the plan against the archive through the write functions.
//
// The ids are the Local copy's own: migration 0015 already gave Videos and Chapters the deterministic uuids of
// `legacyUuid` (src/server/localCopy/ids.ts), Local Songs and Versions were uuids from the start, Local Artists got
// `legacyUuid("artist", n)`. A Local Song, Version or Artist becomes the Proposed row of the same id, so every pointer
// keeps its value and only moves from the archive column of its pair to the Proposed one.
import type { EditInput, WriteVideosPayloads, WriteProposedSongsPayloads, WriteProposedVersionsPayloads, ArtistLinkInput } from "../../shared/archiveWire";
import type { ChapterSource, LatinSource, SuggestionSource, VideoType } from "../../shared/sharedRows";
import { foldQuery } from "../../shared/fold";

// ---------------------------------------------------------------------------------------------------------------
// The snapshot: what the plan reads from library.db (after migrations 0015-0017)
// ---------------------------------------------------------------------------------------------------------------

export interface SnapVideo {
  id: string;
  youtube_id: string | null;
  content_hash: string | null;
  instagram_id: string | null;
  rutube_id: string | null;
  title: string;
  title_latin: string | null;
  title_latin_source: LatinSource | null;
  type: VideoType;
  type_suggested: boolean;
  song_id: string | null;
  proposed_song_id: string | null;
  version_id: string | null;
  proposed_version_id: string | null;
  song_suggested: boolean;
  suggestion_source: SuggestionSource | null;
  deleted_at: string | null;
  delete_reason: string | null;
  created_at: string;
}

export interface SnapChapter {
  id: string;
  video_id: string;
  start_s: number;
  title: string;
  title_latin: string | null;
  song_id: string | null;
  proposed_song_id: string | null;
  version_id: string | null;
  proposed_version_id: string | null;
  suggested: boolean;
  source: ChapterSource;
}

export interface SnapLink {
  video_id: string;
  artist_id: string | null;
  proposed_artist_id: string | null;
  position: number;
  suggested: boolean;
}

export interface SnapChapterRejection {
  id: string;
  video_id: string;
  source: string;
  start_s: number;
  created_at: string | null;
}

export interface SnapArtistRejection {
  id: string;
  video_id: string;
  artist_id: string | null;
  proposed_artist_id: string | null;
  created_at: string | null;
}

/** A row of `deleted_video` (migration 0011): a Video deleted from the library while files stayed on disk. */
export interface SnapDeletedVideo {
  id: number;
  youtube_id: string | null;
  content_hash: string | null;
  title: string;
  deleted_at: string;
}

export interface SnapLocalSong {
  id: string;
  name: string;
  english_name: string | null;
  alternate_titles: string | null;
  alternate_spellings: string | null;
}

export interface SnapLocalVersion {
  id: string;
  song_id: string;
  label: string;
  cyrillic: string | null;
  transliteration: string | null;
  translation: string | null;
  footnotes_cyrillic: string;
  footnotes_transliteration: string;
  footnotes_translation: string;
}

export interface SnapLocalArtist {
  id: string;
  name: string;
}

export interface SnapArchiveSong {
  id: string;
  name: string;
  english_name: string | null;
  alternate_titles: string | null;
  alternate_spellings: string | null;
  is_hidden: boolean;
}

export interface SnapArchiveArtist {
  id: string;
  name: string;
  is_hidden: boolean;
}

export interface LibrarySnapshot {
  videos: SnapVideo[];
  chapters: SnapChapter[];
  links: SnapLink[];
  chapterRejections: SnapChapterRejection[];
  artistRejections: SnapArtistRejection[];
  deletedVideos: SnapDeletedVideo[];
  localSongs: SnapLocalSong[];
  localVersions: SnapLocalVersion[];
  localArtists: SnapLocalArtist[];
  archiveSongs: SnapArchiveSong[];
  /** `archive_version`: id and parent Song, for the composite pointer check. */
  archiveVersions: { id: string; song_id: string }[];
  archiveArtists: SnapArchiveArtist[];
}

// ---------------------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------------------

/** The archive's `video_fold` (migration 130): lower case, ё -> е, whitespace and ASCII/typographic punctuation runs -> one space, trimmed. */
export function videoFold(s: string | null | undefined): string | null {
  const f = (s ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[\s!-/:-@[-`{-~«»„“”‘’‚–—…·•]+/g, " ")
    .trim();
  return f === "" ? null : f;
}

/**
 * A looser key for near-duplicates (#87): the search fold (Cyrillic and Latin onto ASCII), j -> y, punctuation
 * dropped, letter runs collapsed ("Choodu" ~ "Chodu", "durujaa" ~ "Duruyaa").
 */
export function nearKey(s: string): string {
  return foldQuery(s)
    .replace(/j/g, "y")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/([a-z])\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** Comma-separated alternate names (the archive's `alternate_titles` form). */
function alternates(s: string | null): string[] {
  return (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);
}

// The #87 findings (docs/research/local-overlap.md) by name: rows a human must decide before they become Proposed.
// Each is matched by `nearKey`, so a rename that keeps the name resolves nothing.
export const NEAR_DUPLICATE_SONGS = ["Karan Duruyaa"];
export const NEAR_DUPLICATE_ARTISTS = ["shodek]", "oducuh", "gend"];
/** Nachyn Chodu / Nachyn Choodu is the fifth: two Local Artists that fold together, caught by the local-vs-local check. */
export const WORKING_NOTE_LABELS = ["Hidde", "Evan", "Notes", "Liner notes", "Möngün-ool Mongush (attempt)", "Additional lyrics"];
/** Junk rows the migration drops instead of carrying (§9.2: "deletes Song eir and Artist aiah"). */
export const DROPPED_SONGS = ["eir"];
export const DROPPED_ARTISTS = ["aiah"];
/** The Local Artist that duplicates a live archive row added after the Mirror's backup (#87). */
export const MAPPED_ARTIST = "Andrei Mongush";

const sameName = (list: string[], name: string) => list.some((n) => nearKey(n) === nearKey(name));

// ---------------------------------------------------------------------------------------------------------------
// Preflight (library.db side)
// ---------------------------------------------------------------------------------------------------------------

export interface NearDuplicate {
  kind: "song" | "artist";
  id: string;
  name: string;
  why: string;
}

export interface Refusals {
  nearDuplicates: NearDuplicate[];
  workingNoteLabels: { id: string; song: string; label: string }[];
  unreferencedSongs: { id: string; name: string; versions: number }[];
  /** Pointers the archive's foreign keys would refuse: a Version not under the Video's (or Chapter's) Song. */
  pointerMismatches: { id: string; table: "videos" | "video_chapters"; why: string }[];
}

export function hasRefusals(r: Refusals): boolean {
  return r.nearDuplicates.length + r.workingNoteLabels.length + r.unreferencedSongs.length + r.pointerMismatches.length > 0;
}

export interface PreflightOptions {
  /** Names (Local Songs or Artists) a human reviewed and accepted as distinct: `--accept <name>`. */
  accept?: string[];
}

/** The Local Song ids a Video or a Chapter points at (Shared-wise referenced; Studio tracks are not Shared). */
function referencedSongIds(snap: LibrarySnapshot): Set<string> {
  const ids = new Set<string>();
  for (const v of snap.videos) if (v.song_id) ids.add(v.song_id);
  for (const c of snap.chapters) if (c.song_id) ids.add(c.song_id);
  return ids;
}

function referencedArtistIds(snap: LibrarySnapshot): Set<string> {
  return new Set(snap.links.map((l) => l.artist_id).filter((x): x is string => !!x));
}

/**
 * Re-counts the §9.2 refusals from the snapshot: the #87 near-duplicates (by name, plus any Local Song or Artist whose
 * near key meets another Local row or an archive row), the working-note Version labels, the unreferenced Local Songs
 * (the dropped junk excepted) and pointers the archive's composite foreign key would refuse. Rows about to be dropped
 * (eir, aiah) and the mapped Andrei Mongush are not near-duplicates.
 */
export function preflight(snap: LibrarySnapshot, opts: PreflightOptions = {}): Refusals {
  const accepted = (name: string) => sameName(opts.accept ?? [], name);
  const refSongs = referencedSongIds(snap);
  const refArtists = referencedArtistIds(snap);
  const nearDuplicates: NearDuplicate[] = [];

  const songs = snap.localSongs.filter((s) => !sameName(DROPPED_SONGS, s.name));
  const artists = snap.localArtists.filter((a) => !sameName(DROPPED_ARTISTS, a.name) && !sameName([MAPPED_ARTIST], a.name));

  // Archive names by near key and by exact fold (the server's dedupe would raise VD422 on the latter).
  const archiveSongKeys = new Map<string, string>();
  for (const s of snap.archiveSongs) {
    for (const n of [s.name, s.english_name, ...alternates(s.alternate_titles), ...alternates(s.alternate_spellings)]) {
      if (n && nearKey(n)) archiveSongKeys.set(nearKey(n), s.name);
    }
  }
  const archiveSongFolds = new Map<string, string>();
  for (const s of snap.archiveSongs) for (const n of [s.name, s.english_name]) { const f = videoFold(n); if (f) archiveSongFolds.set(f, s.name); }
  const archiveArtistKeys = new Map(snap.archiveArtists.map((a) => [nearKey(a.name), a.name]));
  const archiveArtistFolds = new Map(snap.archiveArtists.map((a) => [videoFold(a.name) ?? "", a.name]));

  for (const s of songs) {
    if (accepted(s.name)) continue;
    const why: string[] = [];
    if (sameName(NEAR_DUPLICATE_SONGS, s.name)) why.push("#87 near-duplicate");
    const f = videoFold(s.name);
    if (f && archiveSongFolds.has(f)) why.push(`same name as archive Song "${archiveSongFolds.get(f)}" (the dedupe would refuse it)`);
    else if (archiveSongKeys.has(nearKey(s.name))) why.push(`near archive Song "${archiveSongKeys.get(nearKey(s.name))}"`);
    const twin = songs.find((o) => o.id !== s.id && nearKey(o.name) === nearKey(s.name));
    if (twin) why.push(`near Local Song "${twin.name}"`);
    if (why.length) nearDuplicates.push({ kind: "song", id: s.id, name: s.name, why: why.join("; ") });
  }
  for (const a of artists) {
    if (accepted(a.name)) continue;
    const why: string[] = [];
    if (sameName(NEAR_DUPLICATE_ARTISTS, a.name)) why.push("#87 near-duplicate");
    const f = videoFold(a.name);
    if (f && archiveArtistFolds.has(f)) why.push(`same name as archive Artist "${archiveArtistFolds.get(f)}" (the dedupe would refuse it)`);
    else if (archiveArtistKeys.has(nearKey(a.name))) why.push(`near archive Artist "${archiveArtistKeys.get(nearKey(a.name))}"`);
    const twin = artists.find((o) => o.id !== a.id && nearKey(o.name) === nearKey(a.name));
    if (twin) why.push(`near Local Artist "${twin.name}"`);
    if (why.length && (refArtists.has(a.id) || why[0] === "#87 near-duplicate")) nearDuplicates.push({ kind: "artist", id: a.id, name: a.name, why: why.join("; ") });
  }

  const songName = new Map(snap.localSongs.map((s) => [s.id, s.name]));
  const workingNoteLabels = snap.localVersions
    .filter((v) => sameLabel(v.label))
    .map((v) => ({ id: v.id, song: songName.get(v.song_id) ?? v.song_id, label: v.label }));

  const unreferencedSongs = songs
    .filter((s) => !refSongs.has(s.id) && !accepted(s.name))
    .map((s) => ({ id: s.id, name: s.name, versions: snap.localVersions.filter((v) => v.song_id === s.id).length }));

  return { nearDuplicates, workingNoteLabels, unreferencedSongs, pointerMismatches: pointerMismatches(snap) };
}

const sameLabel = (label: string) => WORKING_NOTE_LABELS.some((l) => l.normalize("NFC").toLowerCase() === label.normalize("NFC").trim().toLowerCase());

function pointerMismatches(snap: LibrarySnapshot): Refusals["pointerMismatches"] {
  const versionSong = new Map<string, string>();
  for (const v of snap.archiveVersions) versionSong.set(v.id, v.song_id);
  for (const v of snap.localVersions) versionSong.set(v.id, v.song_id);
  const out: Refusals["pointerMismatches"] = [];
  const check = (id: string, table: "videos" | "video_chapters", song: string | null, version: string | null) => {
    if (!version) return;
    const parent = versionSong.get(version);
    if (parent === undefined) out.push({ id, table, why: `Version ${version} is in neither the archive rows nor the Local Versions` });
    else if (parent !== song) out.push({ id, table, why: `Version ${version} belongs to Song ${parent}, not ${song ?? "none"}` });
  };
  for (const v of snap.videos) check(v.id, "videos", v.song_id ?? v.proposed_song_id, v.version_id ?? v.proposed_version_id);
  for (const c of snap.chapters) check(c.id, "video_chapters", c.song_id ?? c.proposed_song_id, c.version_id ?? c.proposed_version_id);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------------------------

/** The uuid for a `deleted_video` row: the `legacyUuid` layout with prefix "del\0" (64656c00), apart from Videos' own. */
export function deletedVideoUuid(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffffffff) throw new RangeError(`not a deleted_video id: ${n}`);
  return `64656c00-0000-8000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** A Shared poster to upload before its Video is inserted: object path `<video uuid>/<sha256 prefix>.webp` (§6.5). */
export interface PosterUpload {
  file: string;
  path: string;
  bytes: number;
}

/** What the CLI knows about a Video's local poster file: the file, its size and its SHA-256 (hex). */
export interface PosterFile {
  file: string;
  sha256: string;
  bytes: number;
}

/** The bucket's limit (migration 130: 1 MiB). */
export const POSTER_LIMIT = 1048576;

export const posterPath = (videoId: string, sha256: string) => `${videoId}/${sha256.slice(0, 16)}.webp`;

export type Step =
  | { key: string; kind: "proposed_song"; id: string; payload: WriteProposedSongsPayloads["create"]; edits: EditInput[] }
  | { key: string; kind: "proposed_version"; id: string; payload: WriteProposedVersionsPayloads["create"]; edits: EditInput[] }
  | { key: string; kind: "proposed_artist"; id: string; payload: { name: string }; edits: EditInput[] }
  | { key: string; kind: "video"; id: string; payload: WriteVideosPayloads["insert"]; edits: EditInput[]; poster: PosterUpload | null; createdAt: string; title: string }
  | { key: string; kind: "deleted_video"; id: string; payload: WriteVideosPayloads["insert"]; edits: EditInput[]; deleteEdits: EditInput[]; reason: string; createdAt: string; title: string };

export interface ExposureEntry {
  songId: string;
  name: string;
  videos: number;
  chapters: number;
}

export interface Plan {
  /** The writes, in order: Proposed Songs -> Versions -> Artists, then Videos (with Chapters and Artist links), then the deletions. */
  steps: Step[];
  /** `video_chapter_rejections` rows, written after the Videos (ids kept). */
  chapterRejections: { id: string; video_id: string; source: string; start_s: number; created_at: string | null }[];
  artistRejections: { id: string; video_id: string; artist_id: string | null; proposed_artist_id: string | null; created_at: string | null }[];
  /** `videos.created_at` as the library has it, restored after the inserts (the write functions stamp `now()`). */
  createdAt: { id: string; title: string; youtube_id: string | null; content_hash: string | null; created_at: string }[];
  exposure: ExposureEntry[];
  dropped: {
    songs: { id: string; name: string; why: string }[];
    artists: { id: string; name: string; why: string }[];
    deletedVideos: { id: number; title: string; why: string }[];
    posters: { id: string; why: string }[];
  };
  counts: Record<string, number>;
}

export interface PlanOptions {
  /** The live archive row the Local Artist Andrei Mongush maps onto (found by name at run time); null leaves it Proposed. */
  mappedArtistId: string | null;
  /** The local poster file per Video id, when there is one. */
  posters?: Map<string, PosterFile>;
}

const MIGRATED = "Carried from the owner's library by the one-time migration (#113)";

function proposedEdit(table: string, id: string): EditInput {
  return { event_type: "proposed.migrated", description: MIGRATED, new_value: { table, id } };
}

/** JSON text of a footnote list as jsonb; `[]` when it is empty or unreadable. */
function footnotes(s: string | null | undefined): unknown {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * The plan of every write from a snapshot that passed the preflight. Local pointers move to the Proposed column of
 * their pair; the Local Artist Andrei Mongush becomes the live archive row; eir, aiah and unreferenced Local Artists
 * are dropped; a `deleted_video` whose identity is a live Video again is dropped (it was re-added).
 */
export function buildPlan(snap: LibrarySnapshot, opts: PlanOptions): Plan {
  const localSong = new Set(snap.localSongs.map((s) => s.id));
  const localVersion = new Set(snap.localVersions.map((v) => v.id));
  const localArtist = new Map(snap.localArtists.map((a) => [a.id, a]));
  const refSongs = referencedSongIds(snap);
  const refArtists = referencedArtistIds(snap);
  const dropped: Plan["dropped"] = { songs: [], artists: [], deletedVideos: [], posters: [] };
  const steps: Step[] = [];

  // Proposed Songs: the referenced Local Songs (the preflight refused the unreferenced ones, junk aside).
  const carriedSongs = new Set<string>();
  for (const s of snap.localSongs) {
    if (sameName(DROPPED_SONGS, s.name)) { dropped.songs.push({ id: s.id, name: s.name, why: "junk (#87): deleted by the migration" }); continue; }
    if (!refSongs.has(s.id)) { dropped.songs.push({ id: s.id, name: s.name, why: "referenced by no Video or Chapter" }); continue; }
    carriedSongs.add(s.id);
    const alt = [...alternates(s.alternate_titles), ...alternates(s.alternate_spellings)];
    steps.push({
      key: `proposed_song:${s.id}`, kind: "proposed_song", id: s.id,
      payload: { name: s.name, english_name: s.english_name, alternate_titles: alt.length ? [...new Set(alt)].join(", ") : null, notes: null },
      edits: [proposedEdit("video_proposed_songs", s.id)],
    });
  }

  // Proposed Versions: every Local Version under a carried Song, or under an archive Song.
  const archiveSong = new Set(snap.archiveSongs.map((s) => s.id));
  for (const v of snap.localVersions) {
    const underLocal = carriedSongs.has(v.song_id);
    if (!underLocal && !archiveSong.has(v.song_id)) continue;
    steps.push({
      key: `proposed_version:${v.id}`, kind: "proposed_version", id: v.id,
      payload: {
        ...(underLocal ? { proposed_song_id: v.song_id } : { song_id: v.song_id }),
        label: v.label,
        lyrics_cyrillic: v.cyrillic, lyrics_transliteration: v.transliteration, lyrics_translation: v.translation,
        source: null,
        footnotes_cyrillic: footnotes(v.footnotes_cyrillic),
        footnotes_transliteration: footnotes(v.footnotes_transliteration),
        footnotes_translation: footnotes(v.footnotes_translation),
      },
      edits: [proposedEdit("video_proposed_versions", v.id)],
    });
  }

  // Proposed Artists: the linked Local Artists, Andrei Mongush mapped onto the archive row.
  const artistTarget = new Map<string, ArtistLinkInput>();
  for (const a of snap.localArtists) {
    if (sameName(DROPPED_ARTISTS, a.name)) { dropped.artists.push({ id: a.id, name: a.name, why: "junk (#87): deleted by the migration" }); continue; }
    if (opts.mappedArtistId && sameName([MAPPED_ARTIST], a.name)) {
      artistTarget.set(a.id, { artist_id: opts.mappedArtistId });
      dropped.artists.push({ id: a.id, name: a.name, why: `mapped onto the archive Artist ${opts.mappedArtistId}` });
      continue;
    }
    if (!refArtists.has(a.id)) { dropped.artists.push({ id: a.id, name: a.name, why: "linked to no Video" }); continue; }
    artistTarget.set(a.id, { proposed_artist_id: a.id });
    steps.push({ key: `proposed_artist:${a.id}`, kind: "proposed_artist", id: a.id, payload: { name: a.name }, edits: [proposedEdit("video_proposed_artists", a.id)] });
  }

  const songPair = (song: string | null, proposed: string | null) =>
    song && localSong.has(song) ? { song_id: null, proposed_song_id: song } : { song_id: song, proposed_song_id: proposed };
  const versionPair = (version: string | null, proposed: string | null) =>
    version && localVersion.has(version) ? { version_id: null, proposed_version_id: version } : { version_id: version, proposed_version_id: proposed };
  const artistRef = (id: string | null, proposed: string | null): ArtistLinkInput | null =>
    id ? (localArtist.has(id) ? artistTarget.get(id) ?? null : { artist_id: id }) : proposed ? { proposed_artist_id: proposed } : null;

  const chaptersOf = groupBy(snap.chapters, (c) => c.video_id);
  const linksOf = groupBy(snap.links, (l) => l.video_id);
  const createdAt: Plan["createdAt"] = [];
  let chapters = 0;
  let links = 0;
  let posters = 0;

  for (const v of snap.videos) {
    const chs = (chaptersOf.get(v.id) ?? []).sort((a, b) => a.start_s - b.start_s);
    const seen = new Set<string>();
    const artists: ArtistLinkInput[] = [];
    for (const l of (linksOf.get(v.id) ?? []).sort((a, b) => a.position - b.position)) {
      const ref = artistRef(l.artist_id, l.proposed_artist_id);
      if (!ref) continue;
      const k = ref.artist_id ?? `p:${ref.proposed_artist_id}`;
      if (seen.has(k)) continue;
      seen.add(k);
      artists.push({ ...ref, suggested: l.suggested });
    }
    chapters += chs.length;
    links += artists.length;
    const pf = opts.posters?.get(v.id);
    let poster: PosterUpload | null = null;
    if (pf && pf.bytes > POSTER_LIMIT) dropped.posters.push({ id: v.id, why: `${pf.bytes} bytes, over the bucket's 1 MiB` });
    else if (pf) { poster = { file: pf.file, path: posterPath(v.id, pf.sha256), bytes: pf.bytes }; posters++; }
    steps.push({
      key: `video:${v.id}`, kind: "video", id: v.id, title: v.title, createdAt: v.created_at, poster,
      payload: {
        title: v.title, type: v.type, type_suggested: v.type_suggested,
        ...songPair(v.song_id, v.proposed_song_id), ...versionPair(v.version_id, v.proposed_version_id),
        song_suggested: v.song_suggested, suggestion_source: v.suggestion_source,
        title_latin: v.title_latin, title_latin_source: v.title_latin_source,
        instagram_id: v.instagram_id, rutube_id: v.rutube_id, poster_path: poster?.path ?? null,
        youtube_id: v.youtube_id, content_hash: v.content_hash,
        chapters: chs.map((c) => ({
          id: c.id, start_s: c.start_s, title: c.title, title_latin: c.title_latin,
          ...songPair(c.song_id, c.proposed_song_id), ...versionPair(c.version_id, c.proposed_version_id),
          suggested: c.suggested, source: c.source,
        })),
        artists,
      },
      edits: [{ event_type: "video.migrated", description: MIGRATED, new_value: { created_at: v.created_at, chapters: chs.length, artists: artists.length } }],
    });
    createdAt.push({ id: v.id, title: v.title, youtube_id: v.youtube_id, content_hash: v.content_hash, created_at: v.created_at });
  }

  // The deletions: inserted, then soft-deleted with the library's date in the history row.
  const liveIdentity = new Set(snap.videos.flatMap((v) => [v.youtube_id, v.content_hash]).filter((x): x is string => !!x));
  for (const d of snap.deletedVideos) {
    if ((d.youtube_id && liveIdentity.has(d.youtube_id)) || (d.content_hash && liveIdentity.has(d.content_hash))) {
      dropped.deletedVideos.push({ id: d.id, title: d.title, why: "its identity is a live Video again (re-added after the delete)" });
      continue;
    }
    const id = deletedVideoUuid(d.id);
    const reason = "Deleted from the library before sharing";
    steps.push({
      key: `deleted_video:${id}`, kind: "deleted_video", id, title: d.title, createdAt: d.deleted_at, reason,
      payload: { title: d.title, type: "other", youtube_id: d.youtube_id, content_hash: d.content_hash },
      edits: [{ event_type: "video.migrated", description: MIGRATED, new_value: { deleted_video: d.id } }],
      deleteEdits: [{ event_type: "video.deleted", field_name: "deleted_at", old_value: null, new_value: d.deleted_at, description: `${reason} (${d.deleted_at})` }],
    });
    createdAt.push({ id, title: d.title, youtube_id: d.youtube_id, content_hash: d.content_hash, created_at: d.deleted_at });
  }

  const videoIds = new Set(snap.videos.map((v) => v.id));
  const chapterRejections = snap.chapterRejections.filter((r) => videoIds.has(r.video_id));
  const artistRejections = snap.artistRejections.flatMap((r) => {
    if (!videoIds.has(r.video_id)) return [];
    const ref = artistRef(r.artist_id, r.proposed_artist_id);
    return ref ? [{ id: r.id, video_id: r.video_id, artist_id: ref.artist_id ?? null, proposed_artist_id: ref.proposed_artist_id ?? null, created_at: r.created_at }] : [];
  });

  const exposure = exposureList(snap);
  const deletions = steps.filter((s) => s.kind === "deleted_video").length;
  const proposed = (k: Step["kind"]) => steps.filter((s) => s.kind === k).length;
  const counts: Record<string, number> = {
    videos: snap.videos.length,
    chapters,
    artist_links: links,
    artist_links_suggested: steps.reduce((n, s) => n + (s.kind === "video" ? (s.payload.artists ?? []).filter((a) => a.suggested).length : 0), 0),
    videos_type_suggested: snap.videos.filter((v) => v.type_suggested).length,
    videos_song_suggested: snap.videos.filter((v) => v.song_suggested).length,
    chapters_suggested: snap.chapters.filter((c) => c.suggested).length,
    latin_titles_videos: snap.videos.filter((v) => v.title_latin).length,
    latin_titles_chapters: snap.chapters.filter((c) => c.title_latin).length,
    instagram_ids: snap.videos.filter((v) => v.instagram_id).length,
    rutube_ids: snap.videos.filter((v) => v.rutube_id).length,
    posters,
    deletions,
    chapter_rejections: chapterRejections.length,
    artist_rejections: artistRejections.length,
    proposed_songs: proposed("proposed_song"),
    proposed_versions: proposed("proposed_version"),
    proposed_artists: proposed("proposed_artist"),
    history_rows: steps.length + deletions,
    exposure_songs: exposure.length,
    exposure_videos: exposure.reduce((n, e) => n + e.videos, 0),
  };
  return { steps, chapterRejections, artistRejections, createdAt, exposure, dropped, counts };
}

/** The hidden archive Songs Videos or Chapters point at (§3.5): the initial exposure list, most Videos first. */
export function exposureList(snap: LibrarySnapshot): ExposureEntry[] {
  const hidden = new Map(snap.archiveSongs.filter((s) => s.is_hidden).map((s) => [s.id, s.name]));
  const by = new Map<string, ExposureEntry>();
  const entry = (id: string) => by.get(id) ?? (by.set(id, { songId: id, name: hidden.get(id)!, videos: 0, chapters: 0 }), by.get(id)!);
  for (const v of snap.videos) if (v.song_id && hidden.has(v.song_id)) entry(v.song_id).videos++;
  for (const c of snap.chapters) if (c.song_id && hidden.has(c.song_id)) entry(c.song_id).chapters++;
  return [...by.values()].sort((a, b) => b.videos - a.videos || b.chapters - a.chapters || a.name.localeCompare(b.name));
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const list = m.get(k);
    if (list) list.push(x);
    else m.set(k, [x]);
  }
  return m;
}

// ---------------------------------------------------------------------------------------------------------------
// Resume
// ---------------------------------------------------------------------------------------------------------------

/**
 * The resume marker (`<data dir>/migrate-shared.state.json`): written before the first write, removed when the run
 * finishes. Its presence is what lets a run start on a non-empty target; what is done is read back from the target.
 */
export interface ResumeState {
  started_at: string;
  /** The planned row ids, so a resumed run can tell its own rows from anything else in the target. */
  planned: number;
}

/** The ids the target holds, as a resumed run reads them with the service-role key. */
export interface TargetRows {
  videos: { id: string; deleted_at: string | null }[];
  video_proposed_songs: string[];
  video_proposed_versions: string[];
  video_proposed_artists: string[];
}

/**
 * What a resumed run finds in the target: the step keys already done (a deletion counts once soft-deleted; inserted
 * but not yet deleted it is `half`), and any row the plan does not know (a seed left unpurged): the run refuses on those.
 */
export function reconcile(plan: Plan, target: TargetRows): { done: Set<string>; half: Set<string>; foreign: string[] } {
  const done = new Set<string>();
  const half = new Set<string>();
  const byId = new Map(plan.steps.map((s) => [`${s.kind === "deleted_video" ? "video" : s.kind}:${s.id}`, s]));
  const foreign: string[] = [];
  const mark = (kind: string, id: string, deletedAt: string | null = null) => {
    const s = byId.get(`${kind}:${id}`);
    if (!s) return void foreign.push(`${kind} ${id}`);
    if (s.kind === "deleted_video" && !deletedAt) half.add(s.key);
    else done.add(s.key);
  };
  for (const v of target.videos) mark("video", v.id, v.deleted_at);
  for (const id of target.video_proposed_songs) mark("proposed_song", id);
  for (const id of target.video_proposed_versions) mark("proposed_version", id);
  for (const id of target.video_proposed_artists) mark("proposed_artist", id);
  return { done, half, foreign };
}
