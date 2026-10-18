// The Shelved diff builder (src/shared/shelvedDiff.ts; ticket #157): pure.
import { describe, expect, test } from "bun:test";
import { artistsText, clock, diffRow, mapNames, songText, videoDiffs, type DiffNow } from "../src/shared/shelvedDiff";
import { shelveLine } from "../src/web/chipView";

const names = mapNames({
  songs: new Map([["s1", "Mezhegei"], ["s2", "Kongurei"]]),
  versions: new Map([["v1", "Complete"], ["v2", "Short"]]),
  artists: new Map([["a1", "Huun-Huur-Tu"], ["a2", "Alash"]]),
});
const now: DiffNow = {
  title: "Shared title", type: "concert", songId: "s2", versionId: "v2", artistIds: ["a2"],
  chapters: [{ startS: 30, title: "Verse", songId: "s2", versionId: null }],
};

describe("the diff rows", () => {
  test("each attribute: the local value (before) against the Shared one (after)", () => {
    expect(diffRow({ kind: "title", title: "My title", titleLatin: null }, now, names)).toEqual({ attr: "title", label: "Title", before: "My title", after: "Shared title" });
    expect(diffRow({ kind: "type", type: "song" }, now, names)).toEqual({ attr: "type", label: "Type", before: "song", after: "concert" });
    expect(diffRow({ kind: "song", songId: "s1", versionId: "v1" }, now, names)).toEqual({ attr: "song", label: "Song", before: "Mezhegei · Complete", after: "Kongurei · Short" });
    expect(diffRow({ kind: "song", songId: "s1", versionId: null }, { ...now, songId: null, versionId: null }, names).after).toBe("No Song");
    expect(diffRow({ kind: "artists", artistIds: ["a1", "a2"] }, now, names)).toEqual({ attr: "artists", label: "Artists", before: "Huun-Huur-Tu, Alash", after: "Alash" });
  });

  test("a Chapter shows the Shared Chapter at the same start, or that there is none", () => {
    const at = (startS: number) => diffRow({ kind: "chapter", startS, title: "Mine", songId: "s1", versionId: null, favoritedAt: null }, now, names);
    expect(at(30)).toEqual({ attr: "chapter", label: "Chapter at 0:30", before: "“Mine” · Mezhegei", after: "“Verse” · Kongurei" });
    expect(at(125)).toEqual({ attr: "chapter", label: "Chapter at 2:05", before: "“Mine” · Mezhegei", after: "No Chapter here" });
  });

  test("unknown and empty values read as words, not blanks", () => {
    expect(songText("zz", null, names)).toBe("an unknown row");
    expect(artistsText([], names)).toBe("No Artists");
    expect(diffRow({ kind: "title", title: "  ", titleLatin: null }, now, names).before).toBe("(no title)");
    expect(diffRow({ kind: "type", type: "song" }, { ...now, type: null }, names).after).toBe("other");
    expect(clock(61.9)).toBe("1:01");
  });

  test("names fall back to the Local copy for ids the batch lacks", () => {
    const n = mapNames({ songs: new Map(), versions: new Map(), artists: new Map([["a1", "From batch"]]) }, { song: () => "Local song", version: () => null, artist: () => "Local artist" });
    expect(n.song("x")).toBe("Local song");
    expect(n.artist("a1")).toBe("From batch");
    expect(n.version("x")).toBeNull();
  });

  test("grouped per Video in first-seen order; a Video not known says so", () => {
    const d = videoDiffs(
      [
        { videoId: "V1", value: { kind: "title", title: "Mine", titleLatin: null } },
        { videoId: "V2", value: { kind: "type", type: "song" } },
        { videoId: "V1", value: { kind: "artists", artistIds: ["a1"] } },
      ],
      (id) => (id === "V1" ? { ...now, videoTitle: "Shared title" } : null),
      names,
    );
    expect(d.map((v) => [v.videoId, v.videoTitle, v.rows.map((r) => r.attr)])).toEqual([
      ["V1", "Shared title", ["title", "artists"]],
      ["V2", "(gone)", ["type"]],
    ]);
    expect(d[1]!.rows[0]!.after).toBe("(not in the shared library)");
  });
});

describe("the confirmation and popup sentences", () => {
  test("before and after, with the Videos they are on", () => {
    expect(shelveLine(3, 2)).toBe("3 local edits on 2 Videos will be shelved: kept on this machine, read-only.");
    expect(shelveLine(1, 1, true)).toBe("1 local edit on 1 Video was shelved: kept on this machine, read-only. The shared library's values show now.");
    expect(shelveLine(0, 0, true)).toBe("Nothing on this machine was shelved.");
  });
});
