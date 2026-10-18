// The sign-in UI's pure parts (docs/sharing-spec.md §2.2, §5.1, §5.3, §5.4, §7.3; ticket #131): which chip renders
// from which session state, what the menu's Sync row says, whether the dialog's Submit is blocked, and which edit
// controls a Video shows. No I/O and no preact: Account.tsx renders these from useSession() (src/web/session.ts).
import type { EndedReason, SessionRecord } from "../shared/session";

/** The fields of useSession() the chip reads. */
export interface ChipInput {
  record: SessionRecord | null;
  recordLoaded: boolean;
  authSettled: boolean;
  browserSignedIn: boolean;
  reachable: boolean | null;
  syncing: boolean;
  lastSyncError: string | null;
}

export interface SyncRow {
  /** "Syncing…", "The archive can't be reached", or "Last Sync 5 min ago". */
  line: string;
  /** The last Sync error in one line, or null. */
  error: string | null;
  /** The Sync button works: this browser holds a session and no Sync runs. */
  canSync: boolean;
}

export type ChipView =
  /** Before `/api/session` answers: render nothing rather than flash "Sign in" over a signed-in machine. */
  | { kind: "none" }
  /** §2.2 no session, or §5.3 a record but no session in this browser once auth settled: a plain "Sign in" button. */
  | { kind: "sign-in" }
  | {
      kind: "chip";
      initials: string;
      avatarUrl: string | null;
      displayName: string;
      email: string | null;
      /** The role pill; null for an account without the video grant ("No video library access"). */
      role: "Video Editor" | "Member" | null;
      /** The small slashed dot (§2.2): the archive was not reached, or auth is unsettled (§5.3: unsettled = offline). */
      offline: boolean;
      sync: SyncRow;
      /**
       * §6.4 "Refresh all Shared data" (M33): null for an account without the grant (nothing Shared to refresh);
       * otherwise shown, enabled only while a Sync could run and the archive is not known unreachable.
       */
      refreshAll: { enabled: boolean } | null;
    };

export const OFFLINE_LINE = "The archive can't be reached";
/** #158: an account without the video grant reads exactly this pair, once (red line, then grey line). */
export const NO_ACCESS_LINE = "This account has no access to the shared library";
export const NO_ACCESS_HINT = "Ask the owner for video access";
/** The Sync errors that only repeat the no-access pair (src/server/sync.ts). */
const NO_ACCESS_ERROR = /\bno (longer has )?access to the shared library\b/i;
/** The one confirm before "Refresh all Shared data". */
export const REFRESH_ALL_CONFIRM = "Re-download all Shared data from the archive? Your local tags and Favorites are kept.";

export function initials(name: string | null, email: string | null): string {
  const src = (name ?? "").trim() || (email ?? "").split("@")[0]!.trim();
  if (!src) return "?";
  const words = src.split(/[\s._-]+/).filter(Boolean);
  if (!words.length) return "?";
  const letters = words.length > 1 ? words[0]![0]! + words[words.length - 1]![0]! : [...words[0]!].slice(0, 2).join("");
  return letters.toUpperCase();
}

/** "just now", "5 min ago", "3 h ago", "2 days ago"; "never" when there was no Sync. */
export function ago(iso: string | null, nowMs: number): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const s = Math.max(0, Math.round((nowMs - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function chipView(s: ChipInput, nowMs: number): ChipView {
  if (!s.recordLoaded) return { kind: "none" };
  const r = s.record;
  if (!r) return { kind: "sign-in" };
  // §5.3: the chip renders at once from the record; a settled browser with no session of its own shows "Sign in"
  // and leaves the record alone.
  if (s.authSettled && !s.browserSignedIn) return { kind: "sign-in" };
  const offline = !s.authSettled || s.reachable === false;
  const line = s.syncing ? "Syncing…" : offline ? OFFLINE_LINE : `Last Sync ${ago(r.lastSyncAt, nowMs)}`;
  const role = r.grantLevel === "editor" ? "Video Editor" : r.grantLevel === "member" ? "Member" : null;
  // An unreachable Sync's error repeats the offline line, a no-grant Sync's error the no-access pair: say each once.
  const repeats = s.lastSyncError === line || (role === null && !!s.lastSyncError && NO_ACCESS_ERROR.test(s.lastSyncError));
  return {
    kind: "chip",
    initials: initials(r.displayName, r.email),
    avatarUrl: r.avatarUrl,
    displayName: r.displayName?.trim() || r.email || "Signed in",
    email: r.email,
    role,
    offline,
    sync: { line, error: repeats ? null : s.lastSyncError, canSync: s.browserSignedIn && !s.syncing },
    refreshAll: role ? { enabled: s.browserSignedIn && !s.syncing && !offline } : null,
  };
}

/**
 * §5.1 "Submit is disabled while the archive is unreachable". The hook's `reachable` is refreshed only by a probe or
 * a Sync, which need a session, so it is trusted only while this browser holds one; otherwise the browser's own
 * offline flag decides (a stale false would lock a signed-out machine out of signing in).
 */
export function submitBlocked(s: { reachable: boolean | null; browserSignedIn: boolean; online: boolean }): boolean {
  return !s.online || (s.browserSignedIn && s.reachable === false);
}

/** The §5.4 banner's line; null when there is none. Both reasons read the same to the person. */
export function endedLine(ended: EndedReason | null): string | null {
  return ended ? "Your session ended. Sign in again." : null;
}

export type EditGate = "enabled" | "disabled" | "hidden";

/**
 * §2.5, §7.3: edit controls on a Shared Video are hidden for a Member (and for a signed-out machine, whose Local copy
 * is read-only, §2.4), shown but disabled with a notice for a Video Editor offline or unsettled, enabled for a Video
 * Editor with `canEdit`. Unshared Videos (every Video in Standalone) stay editable locally.
 */
export function editGate(video: { shared: boolean }, s: { editorView: boolean; canEdit: boolean }): EditGate {
  if (!video.shared) return "enabled";
  if (!s.editorView) return "hidden";
  return s.canEdit ? "enabled" : "disabled";
}

export const EDIT_DISABLED_NOTICE = "Editing needs the archive: reconnect, then Sync from the account menu.";

/** The reconciliation confirmation's sentence (§2.3, §5.1); the count is a placeholder until #117. */
export function shelveLine(count: number): string {
  if (count <= 0) return "Nothing on this machine will be shelved.";
  return `${count} local edit${count === 1 ? "" : "s"} will be shelved: kept on this machine, read-only.`;
}

export const FORGOT_URL = "https://songsofthesteppe.org";
