// The card's hover estimate (downloader-spec §8, §3.4): one Video's "≈ size" at the quality a card click would use
// (the last job's, else 1080p, as `POST /api/downloads/card` defaults it). `GET /api/downloads/card/estimate?videoId=`.

import type { Db } from "../db";
import { estimateVideoBytes, type Quality } from "../../shared/downloadEstimate";

/** A stored or requested quality in either spelling (`720` / `720p`, `1080` / `1080p`, `best`) → the estimate's key. */
export function estimateQuality(q: unknown): Quality {
  const s = String(q ?? "").toLowerCase();
  if (s === "720" || s === "720p") return "720p";
  if (s === "best") return "best";
  return "1080p";
}

export function cardEstimate(db: Db, videoId: string): { videoId: string; quality: Quality; estBytes: number | null } | null {
  const v = db.query("SELECT size_bytes, duration_s, height FROM videos WHERE id = ? AND deleted_at IS NULL").get(videoId) as { size_bytes: number | null; duration_s: number | null; height: number | null } | null;
  if (!v) return null;
  const last = db.query("SELECT quality FROM download_job ORDER BY id DESC LIMIT 1").get() as { quality: string } | null;
  const quality = estimateQuality(last?.quality);
  return { videoId, quality, estBytes: estimateVideoBytes({ sizeBytes: v.size_bytes, durationS: v.duration_s, height: v.height }, quality) };
}
