// The sign-in UI's pure parts (sharing-spec §2.2, §5.1, §5.3, §5.4, §7.3; ticket #131): which chip renders from which
// session state, the Sync row, the dialog's Submit gate, the banner line and the edit gate.
import { describe, expect, test } from "bun:test";
import { ago, chipView, editGate, endedLine, initials, OFFLINE_LINE, shelveLine, submitBlocked, type ChipInput } from "../src/web/chipView";
import type { SessionRecord } from "../src/shared/session";

const NOW = Date.parse("2026-10-17T12:00:00Z");
const rec = (o: Partial<SessionRecord> = {}): SessionRecord => ({
  userId: "u1", email: "aldyn@example.org", displayName: "Aldyn Ondar", avatarUrl: null, grantLevel: "editor", archiveRole: "contributor",
  lastVerifiedAt: "2026-10-17T11:00:00Z", lastSyncAt: "2026-10-17T11:55:00Z", watermark: null, ...o,
});
const st = (o: Partial<ChipInput> = {}): ChipInput => ({
  record: rec(), recordLoaded: true, authSettled: true, browserSignedIn: true, reachable: true, syncing: false, lastSyncError: null, ...o,
});
const chip = (o: Partial<ChipInput> = {}) => {
  const v = chipView(st(o), NOW);
  if (v.kind !== "chip") throw new Error(`expected chip, got ${v.kind}`);
  return v;
};

describe("which chip renders", () => {
  test("nothing until /api/session answers", () => {
    expect(chipView(st({ recordLoaded: false, record: null }), NOW)).toEqual({ kind: "none" });
  });
  test("no record: a plain Sign in button (§2.2)", () => {
    expect(chipView(st({ record: null }), NOW)).toEqual({ kind: "sign-in" });
    expect(chipView(st({ record: null, browserSignedIn: false }), NOW)).toEqual({ kind: "sign-in" });
  });
  test("a record renders the chip at once, before auth settles, as offline (§5.3)", () => {
    const v = chip({ authSettled: false, browserSignedIn: false, reachable: null });
    expect(v.offline).toBe(true);
    expect(v.sync.line).toBe(OFFLINE_LINE);
    expect(v.sync.canSync).toBe(false);
  });
  test("a record but no session in this browser once settled: Sign in, record kept (§5.3)", () => {
    expect(chipView(st({ browserSignedIn: false }), NOW)).toEqual({ kind: "sign-in" });
  });
  test("signed in and reached: online, role pill from the grant", () => {
    const v = chip();
    expect(v.offline).toBe(false);
    expect(v.role).toBe("Video Editor");
    expect(chip({ record: rec({ grantLevel: "member" }) }).role).toBe("Member");
  });
  test("no grant: no role pill (the menu says No video library access)", () => {
    expect(chip({ record: rec({ grantLevel: null }) }).role).toBeNull();
  });
  test("unreachable archive: the slashed dot and the offline Sync line", () => {
    const v = chip({ reachable: false });
    expect(v.offline).toBe(true);
    expect(v.sync.line).toBe(OFFLINE_LINE);
    expect(v.sync.canSync).toBe(true);
    // the unreachable Sync's error is the same line: shown once
    expect(chip({ reachable: false, lastSyncError: OFFLINE_LINE }).sync.error).toBeNull();
  });
  test("reachable unknown (null) is not offline", () => {
    expect(chip({ reachable: null }).offline).toBe(false);
  });
  test("avatar, initials, display name fallbacks", () => {
    expect(chip({ record: rec({ avatarUrl: "https://x/a.png" }) }).avatarUrl).toBe("https://x/a.png");
    expect(chip().initials).toBe("AO");
    expect(chip({ record: rec({ displayName: null }) }).displayName).toBe("aldyn@example.org");
    expect(chip({ record: rec({ displayName: "  ", email: null }) }).displayName).toBe("Signed in");
  });
});

describe("the Sync row", () => {
  test("Last Sync with the age, Syncing… during one, the error line", () => {
    expect(chip().sync.line).toBe("Last Sync 5 min ago");
    expect(chip({ record: rec({ lastSyncAt: null }) }).sync.line).toBe("Last Sync never");
    const running = chip({ syncing: true });
    expect(running.sync.line).toBe("Syncing…");
    expect(running.sync.canSync).toBe(false);
    expect(chip({ lastSyncError: "Update TuvaVideos: git pull, then restart" }).sync.error).toBe("Update TuvaVideos: git pull, then restart");
  });
  test("ago", () => {
    expect(ago(null, NOW)).toBe("never");
    expect(ago("garbage", NOW)).toBe("never");
    expect(ago("2026-10-17T11:59:30Z", NOW)).toBe("just now");
    expect(ago("2026-10-17T09:00:00Z", NOW)).toBe("3 h ago");
    expect(ago("2026-10-16T12:00:00Z", NOW)).toBe("1 day ago");
    expect(ago("2026-10-14T12:00:00Z", NOW)).toBe("3 days ago");
  });
  test("initials", () => {
    expect(initials("Aldyn Ondar", null)).toBe("AO");
    expect(initials("Шыырап", null)).toBe("ШЫ");
    expect(initials(null, "kara.kys@example.org")).toBe("KK");
    expect(initials(null, null)).toBe("?");
    expect(initials("", "")).toBe("?");
  });
});

describe("the dialog", () => {
  test("Submit blocked offline, or when this browser's own probe found the archive unreachable", () => {
    expect(submitBlocked({ online: false, reachable: true, browserSignedIn: false })).toBe(true);
    expect(submitBlocked({ online: true, reachable: false, browserSignedIn: true })).toBe(true);
    // a stale reading with no session to refresh it never locks sign-in out
    expect(submitBlocked({ online: true, reachable: false, browserSignedIn: false })).toBe(false);
    expect(submitBlocked({ online: true, reachable: null, browserSignedIn: false })).toBe(false);
  });
  test("the shelve-count line", () => {
    expect(shelveLine(0)).toBe("Nothing on this machine will be shelved.");
    expect(shelveLine(1)).toContain("1 local edit will");
    expect(shelveLine(4)).toContain("4 local edits will");
  });
  test("the §5.4 banner", () => {
    expect(endedLine(null)).toBeNull();
    expect(endedLine("session-ended")).toBe("Your session ended. Sign in again.");
    expect(endedLine("revoked")).toBe("Your session ended. Sign in again.");
  });
});

describe("the edit gate (§7.3)", () => {
  test("Unshared Videos stay editable whatever the session", () => {
    expect(editGate({ shared: false }, { editorView: false, canEdit: false })).toBe("enabled");
  });
  test("Shared: hidden for a Member or signed out, disabled for an editor without canEdit, enabled with it", () => {
    expect(editGate({ shared: true }, { editorView: false, canEdit: false })).toBe("hidden");
    expect(editGate({ shared: true }, { editorView: true, canEdit: false })).toBe("disabled");
    expect(editGate({ shared: true }, { editorView: true, canEdit: true })).toBe("enabled");
  });
});
