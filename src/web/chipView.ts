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
    };

export const OFFLINE_LINE = "The archive can't be reached";

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
  return {
    kind: "chip",
    initials: initials(r.displayName, r.email),
    avatarUrl: r.avatarUrl,
    displayName: r.displayName?.trim() || r.email || "Signed in",
    email: r.email,
    role: r.grantLevel === "editor" ? "Video Editor" : r.grantLevel === "member" ? "Member" : null,
    offline,
    // An unreachable Sync's error repeats the offline line; say it once.
    sync: { line, error: s.lastSyncError === line ? null : s.lastSyncError, canSync: s.browserSignedIn && !s.syncing },
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

/**
 * The reconciliation confirmation's sentence (§2.3, §5.1), or with `done` the post-Sync popup's (#157). `videos` is
 * how many Videos the edits are on (omitted: not said).
 */
export function shelveLine(count: number, videos?: number, done = false): string {
  if (count <= 0) return done ? "Nothing on this machine was shelved." : "Nothing on this machine will be shelved.";
  const on = videos ? ` on ${videos} Video${videos === 1 ? "" : "s"}` : "";
  const edits = `${count} local edit${count === 1 ? "" : "s"}${on}`;
  return done
    ? `${edits} ${count === 1 ? "was" : "were"} shelved: kept on this machine, read-only. The shared library's values show now.`
    : `${edits} will be shelved: kept on this machine, read-only.`;
}

export const FORGOT_URL = "https://songsofthesteppe.org";
