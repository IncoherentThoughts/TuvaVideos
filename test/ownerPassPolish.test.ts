// #158's pure parts: the no-access pair said once, Refresh all Shared data in the chip menu, the browser's network
// events in the session reducer (MO1), the grid's Unshared mark, the `#unshared` token and the schema banner line.
import { describe, expect, test } from "bun:test";
import { chipView, NO_ACCESS_HINT, NO_ACCESS_LINE, OFFLINE_LINE, REFRESH_ALL_CONFIRM, type ChipInput } from "../src/web/chipView";
import { INITIAL_SESSION_STATE, schemaMismatchOf, sessionReducer, type SessionRecord, type SessionState } from "../src/shared/session";
import { sharingMark } from "../src/shared/presence";
import { filterChips, hasVideoFilters, isFilterToken, parseQuery } from "../src/shared/filters";

const NOW = Date.parse("2026-10-18T12:00:00Z");
const rec = (o: Partial<SessionRecord> = {}): SessionRecord => ({
  userId: "u1", email: "aldyn@example.org", displayName: "Aldyn Ondar", avatarUrl: null, grantLevel: "member", archiveRole: null,
  lastVerifiedAt: "2026-10-18T11:00:00Z", lastSyncAt: "2026-10-18T11:55:00Z", watermark: null, ...o,
});
const chip = (o: Partial<ChipInput> = {}) => {
  const v = chipView({ record: rec(), recordLoaded: true, authSettled: true, browserSignedIn: true, reachable: true, syncing: false, lastSyncError: null, ...o }, NOW);
  if (v.kind !== "chip") throw new Error(`expected chip, got ${v.kind}`);
  return v;
};

describe("no access, said once", () => {
  test("the pair", () => {
    expect(NO_ACCESS_LINE).toBe("This account has no access to the shared library");
    expect(NO_ACCESS_HINT).toBe("Ask the owner for video access");
  });
  test("a no-grant Sync's error does not repeat the pair", () => {
    const r = rec({ grantLevel: null });
    expect(chip({ record: r, lastSyncError: "This account has no access to the shared library" }).sync.error).toBeNull();
    expect(chip({ record: r, lastSyncError: "This account no longer has access to the shared library" }).sync.error).toBeNull();
    expect(chip({ record: r, lastSyncError: "Sync failed: boom" }).sync.error).toBe("Sync failed: boom");
  });
  test("a grant holder still sees any error", () => {
    expect(chip({ lastSyncError: "This account no longer has access to the shared library" }).sync.error).toBe("This account no longer has access to the shared library");
  });
});

describe("Refresh all Shared data (M33)", () => {
  test("grant holders only", () => {
    expect(chip({ record: rec({ grantLevel: null }) }).refreshAll).toBeNull();
    expect(chip().refreshAll).toEqual({ enabled: true });
    expect(chip({ record: rec({ grantLevel: "editor" }) }).refreshAll).toEqual({ enabled: true });
  });
  test("disabled while a Sync runs, offline, unsettled or without this browser's session", () => {
    expect(chip({ syncing: true }).refreshAll).toEqual({ enabled: false });
    expect(chip({ reachable: false }).refreshAll).toEqual({ enabled: false });
    expect(chip({ authSettled: false }).refreshAll).toEqual({ enabled: false });
  });
  test("the one confirm", () => {
    expect(REFRESH_ALL_CONFIRM).toBe("Re-download all Shared data from the archive? Your local tags and Favorites are kept.");
  });
});

describe("the browser's network events (MO1)", () => {
  const on: SessionState = { ...INITIAL_SESSION_STATE, record: rec(), recordLoaded: true, authSettled: true, reachable: true };
  test("offline: unreachable at once, so the slashed dot shows", () => {
    const s = sessionReducer(on, { type: "network", online: false });
    expect(s.reachable).toBe(false);
    expect(chip({ reachable: s.reachable }).offline).toBe(true);
    expect(chip({ reachable: s.reachable }).sync.line).toBe(OFFLINE_LINE);
  });
  test("online: nothing changes until the next probe or Sync (no Sync on return, §6.4)", () => {
    const off = sessionReducer(on, { type: "network", online: false });
    expect(sessionReducer(off, { type: "network", online: true })).toBe(off);
    expect(sessionReducer(on, { type: "network", online: true })).toBe(on);
    expect(sessionReducer(off, { type: "reach", reachable: true }).reachable).toBe(true);
  });
  test("offline twice is one change", () => {
    const off = sessionReducer(on, { type: "network", online: false });
    expect(sessionReducer(off, { type: "network", online: false })).toBe(off);
  });
});

describe("the grid's Unshared mark", () => {
  test("only Unshared Videos on a machine with the grant", () => {
    expect(sharingMark({ shared: false }, true)).toBe("unshared");
    expect(sharingMark({ shared: true }, true)).toBeNull();
  });
  test("Standalone or no grant: every Video is Unshared, no card is marked", () => {
    expect(sharingMark({ shared: false }, false)).toBeNull();
    expect(sharingMark({ shared: true }, false)).toBeNull();
  });
});

describe("#unshared", () => {
  test("parses as a Video filter with a pill", () => {
    const p = parseQuery("#unshared khoomei");
    expect(p.unshared).toBe(true);
    expect(p.text).toBe("khoomei");
    expect(hasVideoFilters(p)).toBe(true);
    expect(filterChips(p)).toContainEqual({ token: "#unshared", label: "#unshared" });
    expect(isFilterToken("#unshared")).toBe(true);
    expect(parseQuery("unshared").unshared).toBe(false);
  });
});

describe("the schema banner line (M30, M31)", () => {
  test("behind: update; ahead: names the mismatch; equal: none", () => {
    expect(schemaMismatchOf(1, 2)).toMatchObject({ behind: true, line: "Update TuvaVideos: git pull, then restart" });
    const ahead = schemaMismatchOf(3, 2)!;
    expect(ahead.behind).toBe(false);
    expect(ahead.line).toContain("2");
    expect(ahead.line).toContain("3");
    expect(schemaMismatchOf(2, 2)).toBeNull();
  });
  test("an offline network event keeps the banner; a later successful Sync clears it", () => {
    const s: SessionState = { ...INITIAL_SESSION_STATE, record: rec(), schemaMismatch: schemaMismatchOf(1, 2) };
    const off = sessionReducer(s, { type: "network", online: false });
    expect(off.schemaMismatch).not.toBeNull();
    expect(sessionReducer(off, { type: "sync-end", reachable: true, error: null }).schemaMismatch).toBeNull();
  });
});
