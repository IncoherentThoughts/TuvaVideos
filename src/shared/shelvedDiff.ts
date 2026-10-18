// Shelved edits made legible (docs/sharing-spec.md §2.3, §7.4; ticket #157): one red/green row per attribute a
// Video loses to its Shared row, local value → Shared value. Pure: the reconciliation confirmation, the post-Sync
// popup and the Shelved drawer all build their rows here (server side, where the names resolve) and render them
// with one component (src/web/ShelvedDiff.tsx).

/** What a Shelved edit keeps: the values the local row had before the Shared row replaced it (`shelved_edit.payload`). */
export type ShelvedValue =
  | { kind: "title"; title: string; titleLatin: string | null }
  | { kind: "type"; type: string }
  | { kind: "song"; songId: string | null; versionId: string | null }
  | { kind: "artists"; artistIds: string[] }
  | { kind: "chapter"; startS: number; title: string; songId: string | null; versionId: string | null; favoritedAt: string | null };

export type DiffAttr = ShelvedValue["kind"];

/** One attribute that changes: what this machine had (red) and what the Shared library says (green). */
export interface DiffRow {
  attr: DiffAttr;
  /** "Title", "Type", "Song", "Artists", "Chapter at 1:23". */
  label: string;
  before: string;
  after: string;
}

/** Every row one Video loses, under the Video's (Shared) title. */
export interface VideoDiff {
  videoId: string;
  videoTitle: string;
  rows: DiffRow[];
}

/** The Shared side a row compares against: the Video as the Shared library has it. */
export interface DiffNow {
  title: string;
  type: string | null;
  songId: string | null;
  versionId: string | null;
  artistIds: string[];
  chapters: { startS: number; title: string; songId: string | null; versionId: string | null }[];
}

/** Names for the ids the values point at; null when the row is not known here. */
export interface DiffNames {
  song(id: string): string | null;
  version(id: string): string | null;
  artist(id: string): string | null;
}

/** The plain explanation both the confirmation and the popup open with (CONTEXT.md "Shelved (edits)"). */
export const SHELVED_EXPLAINER =
  "Shelved means set aside, not deleted: the tags this machine had on Videos the shared library already knows are kept here, read-only, and the shared library's values show instead. You can look at them, copy one back or clear them any time from the Shelved edits drawer.";

const UNKNOWN = "an unknown row";

export const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** "Song · Version", "Song", or "No Song". */
export function songText(songId: string | null, versionId: string | null, names: DiffNames): string {
  if (!songId) return "No Song";
  const song = names.song(songId) ?? UNKNOWN;
  const version = versionId ? names.version(versionId) : null;
  return version ? `${song} · ${version}` : song;
}

export function artistsText(ids: string[], names: DiffNames): string {
  return ids.length ? ids.map((id) => names.artist(id) ?? UNKNOWN).join(", ") : "No Artists";
}

const typeText = (t: string | null) => (t && t.trim() ? t : "other");
const titleText = (t: string) => (t.trim() ? t : "(no title)");

function chapterText(c: { title: string; songId: string | null; versionId: string | null }, names: DiffNames): string {
  const title = c.title.trim() ? `“${c.title.trim()}”` : "(untitled)";
  return c.songId ? `${title} · ${songText(c.songId, c.versionId, names)}` : title;
}

/** One Shelved value as a diff row against the Shared Video `now`. */
export function diffRow(v: ShelvedValue, now: DiffNow, names: DiffNames): DiffRow {
  switch (v.kind) {
    case "title":
      return { attr: "title", label: "Title", before: titleText(v.title), after: titleText(now.title) };
    case "type":
      return { attr: "type", label: "Type", before: typeText(v.type), after: typeText(now.type) };
    case "song":
      return { attr: "song", label: "Song", before: songText(v.songId, v.versionId, names), after: songText(now.songId, now.versionId, names) };
    case "artists":
      return { attr: "artists", label: "Artists", before: artistsText(v.artistIds, names), after: artistsText(now.artistIds, names) };
    case "chapter": {
      // A shelved Chapter has no Shared twin; the Shared Chapter starting at the same time, if any, is what shows there now.
      const there = now.chapters.find((c) => Math.abs(c.startS - v.startS) < 0.5);
      return { attr: "chapter", label: `Chapter at ${clock(v.startS)}`, before: chapterText(v, names), after: there ? chapterText(there, names) : "No Chapter here" };
    }
  }
}

/**
 * Groups Shelved values by Video, in first-seen order, each Video's rows in the order given. `nowOf` answers the
 * Shared side of a Video (null when the Video is not known: its rows then say "(not in the shared library)").
 */
export function videoDiffs(
  items: { videoId: string; value: ShelvedValue }[],
  nowOf: (videoId: string) => (DiffNow & { videoTitle?: string }) | null,
  names: DiffNames,
): VideoDiff[] {
  const out = new Map<string, VideoDiff>();
  for (const it of items) {
    let d = out.get(it.videoId);
    const now = nowOf(it.videoId);
    if (!d) out.set(it.videoId, (d = { videoId: it.videoId, videoTitle: now ? titleText(now.videoTitle ?? now.title) : "(gone)", rows: [] }));
    d.rows.push(now ? diffRow(it.value, now, names) : { ...diffRow(it.value, EMPTY_NOW, names), after: "(not in the shared library)" });
  }
  return [...out.values()];
}

const EMPTY_NOW: DiffNow = { title: "", type: null, songId: null, versionId: null, artistIds: [], chapters: [] };

/** Names from plain maps, falling back to `fallback` (the Local copy) for ids the maps lack. */
export function mapNames(maps: { songs: Map<string, string>; versions: Map<string, string>; artists: Map<string, string> }, fallback?: DiffNames): DiffNames {
  return {
    song: (id) => maps.songs.get(id) ?? fallback?.song(id) ?? null,
    version: (id) => maps.versions.get(id) ?? fallback?.version(id) ?? null,
    artist: (id) => maps.artists.get(id) ?? fallback?.artist(id) ?? null,
  };
}
