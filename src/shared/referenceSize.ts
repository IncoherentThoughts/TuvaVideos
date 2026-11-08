// Reference size (docs/downloader-spec.md §3.3): a Shared estimate of what a Download weighs, taken from one Video
// Editor's Copy. The companion lists the candidates (src/server/referenceSize.ts); the browser writes each through
// `write_videos update` (src/web/sharing.ts). The pure parts both halves share are here.
import type { EditInput } from "./archiveWire";

/** The tallest Copy a Reference size is taken from; a taller one is chosen only when nothing is at or under it. */
export const REFERENCE_MAX_HEIGHT = 1080;

/** The Copy facts the choice reads (the `copy` columns of one non-Missing Copy). */
export interface CopySizeFacts {
  size: number;
  duration_s: number | null;
  height: number | null;
}

/** The three Shared fields, all positive. */
export interface ReferenceSize {
  size_bytes: number;
  duration_s: number;
  height: number;
}

const pos = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;

/**
 * Which Copy gives the Reference size: among the Copies that can fill all three fields (size, duration and height each
 * positive; a Copy ffprobe could not read is no candidate), the greatest `height` at or under 1080, ties to the larger
 * `size`; when every one is taller, the largest by `size`. Remaining ties keep the earlier Copy (stable, so the choice
 * does not flip between runs). Null when no Copy qualifies.
 */
export function chooseReferenceCopy<T extends CopySizeFacts>(copies: readonly T[]): T | null {
  const ok = copies.filter((c) => pos(c.size) && pos(c.duration_s) && pos(c.height));
  if (!ok.length) return null;
  const low = ok.filter((c) => c.height! <= REFERENCE_MAX_HEIGHT);
  let best: T | null = null;
  if (low.length) {
    for (const c of low) if (!best || c.height! > best.height! || (c.height === best.height && c.size > best.size)) best = c;
  } else {
    for (const c of ok) if (!best || c.size > best.size) best = c;
  }
  return best;
}

/** The Reference size a Copy gives (call on a Copy `chooseReferenceCopy` returned). */
export function referenceSizeOf(c: CopySizeFacts): ReferenceSize {
  return { size_bytes: c.size, duration_s: c.duration_s!, height: c.height! };
}

/** The history row of a fill (`write_videos update` with the three fields): one Edit per Video, like the poster's. */
export function referenceSizeEdit(r: ReferenceSize): EditInput {
  return {
    event_type: "video.reference_size_changed", field_name: "reference_size", old_value: null,
    new_value: { size_bytes: r.size_bytes, duration_s: r.duration_s, height: r.height }, description: "Reference size filled",
  };
}

/** One Video a Video Editor's browser may fill: its stamp for `p_expected_updated_at` and the chosen Copy's numbers. */
export interface ReferenceSizeCandidate extends ReferenceSize {
  videoId: string;
  updatedAt: string;
}

export interface ReferenceSizeFillDeps {
  /** `write_videos update {size_bytes, duration_s, height}` with the stamp and one Edit. */
  write(videoId: string, payload: ReferenceSize, updatedAt: string, edit: EditInput): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>;
  /** `POST /api/cache/apply` with the write's result. */
  apply(result: unknown): Promise<boolean>;
}

export interface ReferenceSizeFillResult {
  filled: number;
  failed: number;
  errors: string[];
}

/** Writes each candidate in turn (a few hundred small calls at most), applying each result to the cache. */
export async function fillReferenceSizes(items: readonly ReferenceSizeCandidate[], d: ReferenceSizeFillDeps): Promise<ReferenceSizeFillResult> {
  const out: ReferenceSizeFillResult = { filled: 0, failed: 0, errors: [] };
  for (const it of items) {
    try {
      const payload: ReferenceSize = { size_bytes: it.size_bytes, duration_s: it.duration_s, height: it.height };
      const w = await d.write(it.videoId, payload, it.updatedAt, referenceSizeEdit(payload));
      if (!w.ok) {
        out.failed++;
        out.errors.push(`reference size ${it.videoId}: ${w.error}`);
        continue;
      }
      if (await d.apply(w.value)) out.filled++;
      else {
        out.failed++;
        out.errors.push(`reference size ${it.videoId}: the cache did not take the row`);
      }
    } catch (e) {
      out.failed++;
      out.errors.push(`reference size ${it.videoId}: ${String(e)}`);
    }
  }
  return out;
}
