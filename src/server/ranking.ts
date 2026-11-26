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

/**
 * home-server-spec §5.3, the Preferred Copy order with the Home Server's Copies: this Mac's usable Copies (Available,
 * not Missing) first, in their own order (`local` comes ranked); then the Home Server's, ranked by the rule above
 * (every one counts as not local, so: plays as-is, larger resolution, smaller size); then this Mac's unusable ones,
 * so the Copy switcher still lists them.
 */
export function preferredCopies<T extends Rankable & { available: boolean; missing: boolean }>(local: readonly T[], home: readonly T[] = []): T[] {
  const usable = (c: T) => c.available && !c.missing;
  const remote = home.map((c, i) => ({ c, i })).sort((x, y) => compareCopies({ ...x.c, rootKind: "external" }, { ...y.c, rootKind: "external" }) || x.i - y.i).map((x) => x.c);
  return [...local.filter(usable), ...remote, ...local.filter((c) => !usable(c))];
}
