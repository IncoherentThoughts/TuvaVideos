// Which Copy the TV plays and from where (docs/tv-spec.md 3.2). The server sends a Video's Copies ranked for the
// browser; the TV re-orders them: local Root first, then one the TV profile plays (its own file or its Fallback),
// then the browser's ranking (larger resolution, smaller size). Pure.
import type { CopyDto } from "../shared/types"

type TvCopy = Pick<CopyDto, "id" | "rootKind" | "available" | "tv">

/** Does the TV play this Copy without the Live remux? An unjudged Copy reads as "live" (the server's rule). */
export const tvPlays = (c: TvCopy): boolean => c.tv.order !== "live"

/** The Copy to play, or null when none is Available (or every one is in `skip`, the Copies that failed this play). Stable: ties keep the server's order. */
export function pickTvCopy<T extends TvCopy>(copies: readonly T[], skip: ReadonlySet<number> = new Set()): T | null {
  const ok = copies.map((c, i) => ({ c, i })).filter((x) => x.c.available && !skip.has(x.c.id))
  ok.sort((a, b) => Number(b.c.rootKind === "local") - Number(a.c.rootKind === "local") || Number(tvPlays(b.c)) - Number(tvPlays(a.c)) || a.i - b.i)
  return ok[0]?.c ?? null
}

export const REMUX_MESSAGE = "This Copy needs the TV Server's remux (not built yet)"

/**
 * The Copy the Player starts with or falls over to: the best Copy the TV plays as-is (a local Copy that needs the Live
 * remux does not shut out an external one that plays), else the best one that needs the remux (the Player says so),
 * else null.
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
