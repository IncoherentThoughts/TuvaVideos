// Unseen Shelved edits and the history action pills (ticket #159; docs/sharing-spec.md §7.4): the seen stamp in the
// Local copy (migration 0018), the helpers the Video page and grid card read, and the pill classification.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { clearShelved, markShelvedSeen, shelvedItems, unseenShelvedVideos } from "../src/server/editHistory";
import { shelve } from "../src/server/localCopy/meta";
import { hasUnseenShelved, unseenVideoIds } from "../src/shared/editHistory";
import { EVENT_TYPES } from "../src/shared/archiveWire";
import { actionPill, writePills } from "../src/shared/historyPill";
import { insertVideo } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");

function setup() {
  const db = openDb(":memory:", MIGRATIONS);
  const v1 = insertVideo(db, { title: "Один", content_hash: "a", shared: 1 });
  const v2 = insertVideo(db, { title: "Два", content_hash: "b", shared: 1 });
  shelve(db, v1, { kind: "title", title: "Мой", titleLatin: null });
  shelve(db, v1, { kind: "type", type: "song" });
  shelve(db, v2, { kind: "type", type: "concert" });
  return { db, v1, v2 };
}

describe("seen (§7.4, #159)", () => {
  test("new Shelved edits start unseen; opening one Video's drawer stamps only that Video", () => {
    const { db, v1, v2 } = setup();
    expect(new Set(unseenShelvedVideos(db))).toEqual(new Set([v1, v2]));
    expect(shelvedItems(db).every((i) => !i.seen)).toBe(true);
    expect(markShelvedSeen(db, v1)).toBe(2);
    expect(markShelvedSeen(db, v1)).toBe(0); // already seen: the stamp is not moved
    expect(unseenShelvedVideos(db)).toEqual([v2]);
    expect(shelvedItems(db, v1).map((i) => i.seen)).toEqual([true, true]);
    expect(unseenVideoIds(shelvedItems(db))).toEqual(new Set([v2]));
  });

  test("the drawer for every Video stamps all; a newly shelved edit is unseen again", () => {
    const { db, v1 } = setup();
    expect(markShelvedSeen(db, null)).toBe(3);
    expect(unseenShelvedVideos(db)).toEqual([]);
    shelve(db, v1, { kind: "song", songId: "s1", versionId: null });
    expect(unseenShelvedVideos(db)).toEqual([v1]);
  });

  test("clearing per Video or all clears the highlight with the rows", () => {
    const { db, v1, v2 } = setup();
    clearShelved(db, v1);
    expect(unseenShelvedVideos(db)).toEqual([v2]);
    clearShelved(db);
    expect(unseenShelvedVideos(db)).toEqual([]);
  });

  test("hasUnseenShelved reads a Set or the route's array", () => {
    expect(hasUnseenShelved(new Set(["a"]), "a")).toBe(true);
    expect(hasUnseenShelved(new Set(["a"]), "b")).toBe(false);
    expect(hasUnseenShelved(["a", "c"], "c")).toBe(true);
    expect(hasUnseenShelved([], "c")).toBe(false);
  });
});

describe("history action pills (#159)", () => {
  test("each event family gets its action", () => {
    const k = (t: string) => actionPill(t).kind;
    expect(k("video.title_changed")).toBe("edit");
    expect(k("chapter.changed")).toBe("edit");
    expect(k("artists.replaced")).toBe("edit");
    expect(k("proposed.song_changed")).toBe("edit");
    expect(k("chapter.added")).toBe("create");
    expect(k("proposed.version_created")).toBe("create");
    expect(actionPill("video.deleted")).toEqual({ kind: "delete", label: "soft delete" });
    expect(actionPill("chapter.deleted")).toEqual({ kind: "delete", label: "delete" });
    expect(k("proposed.artist_deleted")).toBe("delete");
    expect(k("video.restored")).toBe("restore");
    expect(actionPill("chapter.unrejected")).toEqual({ kind: "restore", label: "unreject" });
    expect(k("artist_link.repointed")).toBe("repoint");
    expect(k("video.scanned")).toBe("share");
    expect(k("proposed.song_elevated")).toBe("elevate");
    expect(actionPill("exposure.exposed")).toEqual({ kind: "expose", label: "expose" });
    expect(actionPill("exposure.unexposed")).toEqual({ kind: "expose", label: "unexpose" });
    expect(k("chapter.suggested")).toBe("suggest");
    expect(k("artists.confirmed")).toBe("confirm");
    expect(k("artist_link.rejected")).toBe("reject");
    expect(k("video.migrated")).toBe("migrate");
  });

  test("an undo is an undo whatever it inverts", () => {
    expect(actionPill("video.title_changed", "h1")).toEqual({ kind: "undo", label: "undo" });
    expect(actionPill("video.restored", "h2").kind).toBe("undo");
  });

  test("every registered event type classifies; only the change events fall through to edit", () => {
    const edits = EVENT_TYPES.filter((t) => actionPill(t).kind === "edit");
    expect(edits.every((t) => t.endsWith("_changed") || t === "chapter.changed" || t === "artists.replaced")).toBe(true);
  });

  test("a write shows each distinct action once, in order", () => {
    const pills = writePills([
      { eventType: "chapter.added", reverses: null },
      { eventType: "video.title_changed", reverses: null },
      { eventType: "chapter.added", reverses: null },
      { eventType: "video.type_changed", reverses: "x" },
    ]);
    expect(pills.map((p) => p.label)).toEqual(["create", "edit", "undo"]);
  });
});
