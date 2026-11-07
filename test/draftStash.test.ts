// WEB-4: unsaved lyrics editor drafts kept per Song and Version (src/shared/lyrics/draftStash.ts).
import { expect, test } from "bun:test";
import { createDraftStash } from "../src/shared/lyrics/draftStash";

test("drafts are kept per Song and Version, listed per Song (a new Version first), and dropped", () => {
  const s = createDraftStash<string>();
  s.put({ songId: "a", versionId: "v1", label: "Edit", drafts: "one" });
  s.put({ songId: "a", versionId: null, label: "New", drafts: "two" });
  s.put({ songId: "b", versionId: null, label: "", drafts: "three" });
  expect(s.get("a", "v1")?.drafts).toBe("one");
  expect(s.forSong("a").map((d) => d.versionId)).toEqual([null, "v1"]);
  s.put({ songId: "a", versionId: null, label: "New", drafts: "two, longer" });
  expect(s.get("a", null)?.drafts).toBe("two, longer");
  expect(s.size).toBe(3);
  s.drop("a", null);
  expect(s.get("a", null)).toBeNull();
  expect(s.forSong("a").map((d) => d.versionId)).toEqual(["v1"]);
  expect(s.forSong("c")).toEqual([]);
});
