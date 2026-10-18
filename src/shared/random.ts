// Random Video (top-bar "Random" button, `r` anywhere): a uniformly random Available Video, never the one already playing.

/** The id of a random Available Video other than `exceptId`, or null when none qualifies. `rand` is `Math.random` by default. */
export function pickRandomVideo(videos: { id: string; available: boolean }[], exceptId: string | null = null, rand: () => number = Math.random): string | null {
  const pool = videos.filter((v) => v.available && v.id !== exceptId);
  if (!pool.length) return null;
  return pool[Math.min(pool.length - 1, Math.floor(rand() * pool.length))]!.id;
}
