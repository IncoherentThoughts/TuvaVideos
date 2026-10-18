// Where a Video's file is, as the grid and the Player tell it (sharing-spec §7.1, §7.2, §7.6). Pure.
//   available     an Available Copy: plays now
//   unmounted     a Copy on a Root that is not mounted: dashed drive, "plug the drive in", auto-resume (as today)
//   notHere       Not on this machine: no Copy row, or every Copy Missing (a trashed Copy leaves no row)
import type { CopyDto, VideoDto } from "./types";

export type Presence = "available" | "unmounted" | "notHere";

export function videoPresence(v: Pick<VideoDto, "available"> & { copies: Pick<CopyDto, "missing">[] }): Presence {
  if (v.available) return "available";
  return v.copies.some((c) => !c.missing) ? "unmounted" : "notHere";
}

export const isNotHere = (v: Parameters<typeof videoPresence>[0]) => videoPresence(v) === "notHere";

/**
 * The grid's Shared/Unshared mark (#158). Only a machine signed in with the grant has Shared Videos, so only there
 * does the difference mean anything: the exceptions, Unshared Videos, carry the one mark and a Shared card stays
 * plain. In Standalone (or without the grant) every Video is Unshared and no card is marked.
 */
export function sharingMark(v: Pick<VideoDto, "shared">, granted: boolean): "unshared" | null {
  return granted && !v.shared ? "unshared" : null;
}

/**
 * The "On this machine" chip (§7.2): it selects the Videos with an Available Copy (the `#available` token's set) and
 * is hidden when it would select nothing. It stays while it is on, so a URL that turned it on can turn it off.
 */
export function showOnThisMachineChip(videos: readonly Pick<VideoDto, "available">[] | null | undefined, on: boolean): boolean {
  return on || !!videos?.some((v) => v.available);
}

/** The Video's source link for the Not on this machine panel: YouTube, else Instagram, else Rutube; null when none is known. */
export function sourceLink(v: Pick<VideoDto, "youtubeId" | "instagramId" | "rutubeId">): { site: string; label: string; href: string } | null {
  if (v.youtubeId) return { site: "YouTube", label: `youtube.com/watch?v=${v.youtubeId}`, href: `https://www.youtube.com/watch?v=${v.youtubeId}` };
  if (v.instagramId) return { site: "Instagram", label: `instagram.com/p/${v.instagramId}`, href: `https://www.instagram.com/p/${v.instagramId}/` };
  if (v.rutubeId) return { site: "Rutube", label: `rutube.ru/video/${v.rutubeId}/`, href: `https://rutube.ru/video/${v.rutubeId}/` };
  return null;
}

export const NOT_HERE_MESSAGE = "This Video's link data is here; its file is not. Download it into one of your Roots and it plays.";
