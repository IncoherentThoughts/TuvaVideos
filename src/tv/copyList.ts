// The Copy list (docs/tv-spec.md 6.5): one row per Copy, the playing one marked, a Copy the TV cannot play without the
// Live remux marked "via remux" and greyed until that is built. Pure: Copies in, rows out.
import type { CopyDto } from "../shared/types"

type RowCopy = Pick<CopyDto, "id" | "rootKind" | "container" | "videoCodec" | "audioCodec" | "height" | "width" | "size" | "available" | "missing" | "tv">

export interface CopyRow {
  id: number
  /** "mkv · h264 aac · 1080p" */
  label: string
  /** "1.2 GB" */
  size: string
  /** "local" / "external" */
  root: string
  playing: boolean
  /** The TV profile needs the Live remux for it (`tv.order` is `live`): marked and greyed. */
  viaRemux: boolean
  unavailable: boolean
  /** Enter may switch to it. */
  switchable: boolean
}

export const fmtSize = (b: number): string => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(b / 1e6))} MB`)

/** Container, codecs and resolution as one line; a missing fact is left out. */
export function copyLabel(c: Pick<CopyDto, "container" | "videoCodec" | "audioCodec" | "height" | "width">): string {
  const codecs = [c.videoCodec, c.audioCodec].filter(Boolean).join(" ")
  const res = c.height ? `${c.height}p` : c.width ? `${c.width}w` : ""
  return [c.container, codecs, res].filter(Boolean).join(" · ")
}

export function copyRows(copies: readonly RowCopy[], playingId: number | null): CopyRow[] {
  return copies.map((c) => {
    const viaRemux = c.tv.order === "live"
    const unavailable = !c.available || c.missing
    return {
      id: c.id,
      label: copyLabel(c),
      size: fmtSize(c.size),
      root: c.rootKind,
      playing: c.id === playingId,
      viaRemux,
      unavailable,
      switchable: !viaRemux && !unavailable,
    }
  })
}
