// The home index's two sides as data (docs/home-server-spec.md §5.1, §5.2). On the Home Server: its Videos as the
// `GET /api/home/index` body. On a Mac: a `home_video` row as a read-only VideoDto, and the grid's marks. Pure.
import type { ChapterDto, CopyDto, VideoDto } from "../shared/types";
import type { HomeIndexChapter, HomeIndexDto, HomeIndexVideo, Identity } from "../shared/homeIndex";
import type { HomeCopyRow, HomeView } from "./homeServer";
import { foldText } from "./search";
import { rankCopies } from "./ranking";

/** `/home/thumbs/<id>/poster.webp?v=<key>`: the Home Server's poster, proxied by this Mac's localhost app. */
export const homeThumbUrl = (id: string, key: string) => `/home/thumbs/${id}/poster.webp?v=${encodeURIComponent(key)}`;

/**
 * The Home Server's index body: every Video with at least one Copy that is not Missing, its identity, Copy facts and
 * the browser Playback profile's decision per Copy (`playback`), and its titles, Type and Chapters. Titles go for every
 * Video, not only never-Shared ones: a Mac that does not Sync has no Shared data to show for an unmatched Shared Video.
 */
export function homeIndexBody(server: string, videos: readonly VideoDto[], contentHash: ReadonlyMap<string, string | null>, chapters: ReadonlyMap<string, HomeIndexChapter[]>): HomeIndexDto {
  const out: HomeIndexVideo[] = [];
  for (const v of videos) {
    const copies = v.copies.filter((c) => !c.missing);
    if (!copies.length) continue;
    out.push({
      id: v.id,
      youtubeId: v.youtubeId,
      contentHash: contentHash.get(v.id) ?? null,
      shared: v.shared,
      title: v.title,
      titleLatin: v.titleLatin,
      type: v.type,
      createdAt: v.createdAt,
      thumb: v.thumbnail?.generatedAt ?? null,
      chapters: chapters.get(v.id) ?? [],
      copies: copies.map((c) => ({ id: c.id, size: c.size, container: c.container, videoCodec: c.videoCodec, audioCodec: c.audioCodec, width: c.width, height: c.height, durationS: c.durationS, available: c.available, playback: c.playback })),
    });
  }
  return { server, videos: out };
}

/** The ETag of an index body: a hash of its JSON, so an unchanged library answers 304. */
export const homeIndexEtag = (body: string) => `"${Bun.hash(body).toString(36)}"`;

const best = (copies: readonly HomeCopyRow[]) => [...copies].sort((a, b) => (b.height ?? 0) - (a.height ?? 0) || a.size - b.size)[0]!;

/**
 * A Home Server Copy as the Player's list knows Copies (§5.3, §5.4): `homeId` is its id on the Home Server, `id` its
 * negation (unique beside this Mac's own Copy ids in one list), and it streams through this Mac's `/home/copy/:id`.
 * Only usable Copies get here (`homeView` drops those whose Root is not mounted there), so it is Available. `playback`
 * is the Home Server's browser Playback profile decision; a Fallback there is waited for like a local one.
 */
export function homeCopyDto(c: HomeCopyRow): CopyDto {
  return {
    id: -c.id, homeId: c.id, rootKind: "external", size: c.size, container: c.container, videoCodec: c.video_codec, audioCodec: c.audio_codec, width: c.width, height: c.height,
    durationS: c.duration_s, rFrameRate: null, frameRate: null, available: true, missing: false, playback: c.playback,
    tv: { decision: null, order: "file" }, fallback: { state: "none" }, url: `/home/copy/${c.id}`, path: "",
  };
}

/** The Home Server's Copies of a Video, best first by the existing rule (§5.3). */
const homeCopies = (copies: readonly HomeCopyRow[]): CopyDto[] => rankCopies(copies.map(homeCopyDto));

/** A `home_video` row as a read-only VideoDto: the Home Server's titles, Type and Chapters; On the Home Server. */
export function homeOnlyDto(e: HomeView["homeOnly"][number], server: string | null): VideoDto {
  const { row, copies } = e;
  const top = best(copies);
  return {
    id: row.id, youtubeId: row.youtube_id, instagramId: null, rutubeId: null, shared: !!row.shared, updatedAt: row.created_at,
    title: row.title, titleLatin: row.title_latin, titleLatinSource: null, type: row.type as VideoDto["type"], typeSuggested: false,
    songId: null, versionId: null, song: null, songSuggested: false, suggestionSource: null,
    favoritedAt: null, resumeS: null, lastPlayedAt: null, viewCount: 0, loop: null,
    createdAt: row.created_at, durationS: top.duration_s, available: false, preferredCopyId: null, width: top.width, height: top.height,
    addedAt: row.created_at, chapterCount: e.chapters.length, artists: [], availability: null,
    thumbnail: row.thumb ? { generatedAt: row.thumb, copyId: null, poster: homeThumbUrl(row.id, row.thumb), strip: null } : null,
    copies: [],
    homeCopies: homeCopies(copies),
    home: { copies: copies.length, server },
    homeOnly: true,
  };
}

/** A `home_video` row's Chapters, read-only (no Song pointers: those are the Home Server's). */
export function homeOnlyChapters(e: HomeView["homeOnly"][number]): ChapterDto[] {
  return e.chapters.map((c, i) => ({
    id: `${e.row.id}:${i}`, videoId: e.row.id, startS: c.startS, title: c.title, titleLatin: c.titleLatin, suggested: false, source: "manual",
    songId: null, versionId: null, song: null, favoritedAt: null, updatedAt: e.row.created_at,
  }));
}

/** This Mac's Video, marked when the connected Home Server has a usable Copy of it. */
export function withHome<T extends VideoDto>(v: T, view: HomeView, server: string | null): T {
  const cs = view.matched.get(v.id);
  return cs?.length ? { ...v, home: { copies: cs.length, server }, homeCopies: homeCopies(cs) } : v;
}

/** Search's share of the `home_video` rows (§5.2): a folded title or Latin title containing the needle. */
export function homeOnlySearch(view: HomeView, needle: string): HomeView["homeOnly"] {
  if (!needle) return [];
  return view.homeOnly.filter((e) => foldText(e.row.title).includes(needle) || (!!e.row.title_latin && foldText(e.row.title_latin).includes(needle)));
}

/** This Mac's own Videos' identities, for matching. */
export const localIdentities = (db: { query(sql: string): { all(): unknown[] } }): Identity[] =>
  (db.query("SELECT id, youtube_id, content_hash FROM video_full").all() as { id: string; youtube_id: string | null; content_hash: string | null }[]).map((r) => ({ id: r.id, youtubeId: r.youtube_id, contentHash: r.content_hash }));
