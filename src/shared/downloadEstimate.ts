// Download estimates (docs/downloader-spec.md §3.4): what a Video will weigh at a chosen quality, from its Reference
// size, else its duration; the totals the dialog shows and the time they take. Pure.

export const QUALITIES = ["720p", "1080p", "best"] as const;
export type Quality = (typeof QUALITIES)[number];
export const isQuality = (q: unknown): q is Quality => (QUALITIES as readonly unknown[]).includes(q);

/** The Reference size is taken at a height of 1080 (§3.3), so these ratios are keyed on it. */
export const QUALITY_RATIO: Record<Quality, number> = { "720p": 0.5, "1080p": 1, best: 1.6 };
/** The height a quality's size is rescaled to when the Reference is taller than 1080 (Best counts as 1080 here). */
const SCALE_HEIGHT: Record<Quality, number> = { "720p": 720, "1080p": 1080, best: 1080 };
const REFERENCE_HEIGHT = 1080;
/** Without a Reference size, a duration is costed at about 1080p H.264. */
export const FALLBACK_BITRATE_BPS = 2_500_000;
/** Assumed until a job has finished a Video (§3.4): 2 MB/s, in bytes per second. */
export const ASSUMED_THROUGHPUT_BPS = 2_000_000;
/** Confirm is disabled when the estimate times this exceeds the free space (§3.4). */
export const DISK_MARGIN = 1.1;

export interface SizeFacts {
  sizeBytes?: number | null;
  durationS?: number | null;
  height?: number | null;
}
const pos = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * One Video's estimate in bytes, or null when it has neither a Reference size nor a duration.
 * With a size: size × ratio; a stored height above 1080 (the "largest" fallback) scales by (target/height)², and one
 * below the target is never scaled up. Without: duration × 2.5 Mbit/s × ratio.
 */
export function estimateVideoBytes(f: SizeFacts, quality: Quality): number | null {
  const ratio = QUALITY_RATIO[quality];
  if (pos(f.sizeBytes)) {
    let scale = 1;
    if (pos(f.height) && f.height > REFERENCE_HEIGHT) scale = (SCALE_HEIGHT[quality] / f.height) ** 2;
    return Math.round(f.sizeBytes * ratio * scale);
  }
  if (pos(f.durationS)) return Math.round(((f.durationS * FALLBACK_BITRATE_BPS) / 8) * ratio);
  return null;
}

export interface EstimateTotals {
  count: number;
  estBytes: number;
  withoutEstimate: number;
  estSeconds: number;
}

/** Seconds to fetch `bytes` at `bps` bytes per second (0 when there is nothing to fetch or no usable rate). */
export const estimateSeconds = (bytes: number, bps: number): number => (bytes > 0 && pos(bps) ? Math.round(bytes / bps) : 0);

/** Totals over per-Video estimates (null = no estimate): the sum of the known ones, how many have none, the time. */
export function totalsOf(estimates: readonly (number | null)[], throughputBps: number): EstimateTotals {
  let estBytes = 0;
  let withoutEstimate = 0;
  for (const e of estimates) {
    if (e == null) withoutEstimate++;
    else estBytes += e;
  }
  return { count: estimates.length, estBytes, withoutEstimate, estSeconds: estimateSeconds(estBytes, throughputBps) };
}

/** Whether the disk fits the download: unknown free space never blocks (the dialog cannot tell). */
export const fitsDisk = (estBytes: number, freeBytes: number | null): boolean => freeBytes == null || estBytes * 11 <= freeBytes * 10; // × DISK_MARGIN, without float error
