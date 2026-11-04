// The web app's in-memory library rules (src/shared/clientCache.ts): WEB-6's reload after a Sync, WEB-15's rollback.
import { describe, expect, test } from "bun:test";
import { syncLanded, withFavorite } from "../src/shared/clientCache";

describe("syncLanded (reload after a Sync)", () => {
  test("nothing before the record loads; the first value is the baseline", () => {
    expect(syncLanded(null, false, null)).toEqual({ seen: null, reload: false });
    expect(syncLanded(null, true, "2026-11-04T10:00:00Z")).toEqual({ seen: { at: "2026-11-04T10:00:00Z" }, reload: false });
    expect(syncLanded(null, true, null)).toEqual({ seen: { at: null }, reload: false });
  });
  test("a new lastSyncAt (here, a first sign-in, or another tab's broadcast) reloads once", () => {
    const first = syncLanded({ at: null }, true, "2026-11-04T10:00:00Z");
    expect(first.reload).toBe(true);
    expect(syncLanded(first.seen, true, "2026-11-04T10:00:00Z").reload).toBe(false);
    expect(syncLanded(first.seen, true, "2026-11-04T10:15:00Z").reload).toBe(true);
  });
  test("a cleared record (sign-out) is not a Sync", () => {
    const r = syncLanded({ at: "2026-11-04T10:00:00Z" }, true, null);
    expect(r).toEqual({ seen: { at: null }, reload: false });
  });
});

describe("withFavorite (toggleFavorite's write and rollback)", () => {
  test("only that Video changes; rows that changed meanwhile are kept", () => {
    const now = [
      { id: "a", favoritedAt: null, title: "A (renamed by a poll)" },
      { id: "b", favoritedAt: "2026-11-01", title: "B" },
    ];
    const back = withFavorite(now, "a", "2026-10-01");
    expect(back).toEqual([
      { id: "a", favoritedAt: "2026-10-01", title: "A (renamed by a poll)" },
      { id: "b", favoritedAt: "2026-11-01", title: "B" },
    ]);
    expect(back[1]).toBe(now[1]!);
    expect(withFavorite(now, "gone", null)).toEqual(now);
  });
});
