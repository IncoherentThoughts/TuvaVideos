// Which Copy the TV plays and from where (docs/tv-spec.md 3.2). The server sends a Video's Copies ranked for the
// browser; the TV re-orders them: local Root first, then one the TV profile plays (its own file or its Fallback),
// then the browser's ranking (larger resolution, smaller size). Pure.
import type { CopyDto } from "../shared/types"

type TvCopy = Pick<CopyDto, "id" | "rootKind" | "available" | "tv">

/** Does the TV play this Copy without a Live stream? An unjudged Copy reads as "live" (the server's rule). */
export const tvPlays = (c: TvCopy): boolean => c.tv.order !== "live"

/** The Copy to play, or null when none is Available (or every one is in `skip`, the Copies that failed this play). Stable: ties keep the server's order. */
export function pickTvCopy<T extends TvCopy>(copies: readonly T[], skip: ReadonlySet<number> = new Set()): T | null {
  const ok = copies.map((c, i) => ({ c, i })).filter((x) => x.c.available && !skip.has(x.c.id))
  ok.sort((a, b) => Number(b.c.rootKind === "local") - Number(a.c.rootKind === "local") || Number(tvPlays(b.c)) - Number(tvPlays(a.c)) || a.i - b.i)
  return ok[0]?.c ?? null
}

export const REMUX_MESSAGE = "This Copy needs a Live stream the server cannot make right now"

/** The Live stream of a Copy the TV profile does not play as-is (home-server-spec 7.1): Original, the server sizes it. */
export const liveUrl = (copyId: number): string => `/live/${copyId}/index.m3u8?q=orig`

/** The 503 `busy` answer of `/live/...`: who holds the server's two Live streams. */
export function busyMessage(streams: readonly { device: string; title: string }[] | null | undefined): string {
  const who = (streams ?? []).map((s) => (s.title ? `${s.device} (${s.title})` : s.device)).join(" and ")
  return who ? `The server is busy streaming to ${who}` : "The server is busy streaming to other devices"
}

/**
 * The Copy the Player starts with or falls over to: the best Copy the TV plays as-is (a local Copy that needs a Live
 * stream does not shut out an external one that plays), else the best one that needs a Live stream, else null.
 */
export function pickPlayable<T extends TvCopy>(copies: readonly T[], skip: ReadonlySet<number> = new Set()): { copy: T; live: boolean } | null {
  const ok = pickTvCopy(copies.filter(tvPlays), skip)
  if (ok) return { copy: ok, live: false }
  const live = pickTvCopy(copies, skip)
  return live ? { copy: live, live: true } : null
}

/** "This Copy did not play (mkv h264/aac)". */
export const failedMessage = (c: Pick<CopyDto, "container" | "videoCodec" | "audioCodec">): string =>
  `This Copy did not play (${[c.container, [c.videoCodec, c.audioCodec].filter(Boolean).join("/")].filter(Boolean).join(" ")})`
