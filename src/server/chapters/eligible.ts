// Which Videos the Chapter pipeline looks at (spec 8): Type concert, any Video with a YouTube id longer than 20 min,
// plus ids given by hand. Pure over rows so the fetch script (which reads the library read-only) and the tests share it.

export const LONG_VIDEO_S = 20 * 60;

export interface EligibilityRow {
  id: number;
  youtubeId: string | null;
  type: string;
  durationS: number | null;
}

/** Concerts first (library order), then the longest of the rest; `extra` ids are appended when not already there. */
export function eligibleForFetch(rows: EligibilityRow[], extra: string[] = []): EligibilityRow[] {
  const withId = rows.filter((r) => !!r.youtubeId);
  const concerts = withId.filter((r) => r.type === "concert").sort((a, b) => a.id - b.id);
  const longs = withId.filter((r) => r.type !== "concert" && (r.durationS ?? 0) > LONG_VIDEO_S).sort((a, b) => (b.durationS ?? 0) - (a.durationS ?? 0));
  const out = [...concerts, ...longs];
  const have = new Set(out.map((r) => r.youtubeId));
  for (const id of extra) {
    if (have.has(id)) continue;
    have.add(id);
    out.push(withId.find((r) => r.youtubeId === id) ?? { id: -1, youtubeId: id, type: "other", durationS: null });
  }
  return out;
}
