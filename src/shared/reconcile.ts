// The wire shapes of sign-in reconciliation (docs/sharing-spec.md §2.3; ticket #149), answered by the companion's
// `GET /api/reconcile/preview` and `POST /api/reconcile` and read by the sign-in dialog's confirmation (#131).
import type { SessionRecord } from "./session";
import type { VideoDiff } from "./shelvedDiff";

/** What reconciliation will do (preview) or did (confirm) to this machine's Videos. */
export interface ReconcileCounts {
  /** Local Videos matched to a Shared Video (each takes the Shared row: Shared wins). */
  matched: number;
  /** Shelved edits written: the confirmation's count. */
  shelved: number;
  /** Shared Videos that received at least one Shelved edit. */
  shelvedVideos: number;
  /** Favorite Chapters that left the Favorites list because their Chapter was shelved (the Shelved Chapter keeps the star). */
  favoritesShelved: number;
  /** Unknown Videos queued to be shared (`pending_share`, a Video Editor's only). */
  queued: number;
  /** Unknown Videos that stay Unshared (a Member's). */
  unshared: number;
}

export const NO_RECONCILE: ReconcileCounts = { matched: 0, shelved: 0, shelvedVideos: 0, favoritesShelved: 0, queued: 0, unshared: 0 };

export interface ReconcileResponse {
  ok: boolean;
  /** One line on failure; null on success. */
  error: string | null;
  /** The record `video_whoami()` wrote (the chip renders from it during the confirmation). */
  record: SessionRecord | null;
  /** `video_whoami().must_change_password`, for the dialog's notice. */
  mustChangePassword: boolean;
  counts: ReconcileCounts;
  /**
   * What will be (preview) or was (confirm) shelved, per Video: each attribute's local value against the Shared one
   * (#157). Absent from a companion older than #157.
   */
  diffs?: VideoDiff[];
}
