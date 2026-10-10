// Preferred Copy: local Root first, then plays as-is, then larger resolution, then smaller size. Pure.

export interface Rankable {
  rootKind: "local" | "external";
  playback: "native" | "remux" | "transcode";
  width: number | null;
  height: number | null;
  size: number;
}

const pixels = (c: Rankable) => (c.width ?? 0) * (c.height ?? 0);

export function compareCopies(a: Rankable, b: Rankable): number {
  const local = Number(b.rootKind === "local") - Number(a.rootKind === "local");
  if (local) return local;
  const native = Number(b.playback === "native") - Number(a.playback === "native");
  if (native) return native;
  const px = pixels(b) - pixels(a);
  if (px) return px;
  return a.size - b.size;
}

/** Best first. Stable: equal Copies keep their input order. */
export function rankCopies<T extends Rankable>(copies: readonly T[]): T[] {
  return copies.map((c, i) => ({ c, i })).sort((x, y) => compareCopies(x.c, y.c) || x.i - y.i).map((x) => x.c);
}
