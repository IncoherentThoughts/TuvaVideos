// renameLegacyThumbnails (#137): pre-0015 Thumbnail files named by integer id, content_hash or youtube_id become
// `<uuid>.{poster,strip}.webp`.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { renameLegacyThumbnails } from "../src/server/thumbs";
import { insertVideo, V } from "./helpers/seed";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const HASH = "07d8708b" + "a".repeat(56);
const HASH2 = "b".repeat(64);
const YT = "dQw4w9WgXcQ";
let dir = "";
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("renameLegacyThumbnails", () => {
  test("maps integer, content_hash and youtube_id names to the Video's uuid, idempotently", () => {
    const db = openDb(":memory:", MIGRATIONS);
    insertVideo(db, { id: 1, title: "int", content_hash: "c".repeat(64) });
    const byHash = insertVideo(db, { id: 2, title: "hash", content_hash: HASH });
    const byYt = insertVideo(db, { id: 3, title: "yt", content_hash: "d".repeat(64), youtube_id: YT });
    insertVideo(db, { id: 4, title: "both", content_hash: HASH2 });
    dir = mkdtempSync(join(tmpdir(), "thumbs-"));
    const put = (f: string, body = f) => writeFileSync(join(dir, f), body);
    for (const k of ["poster", "strip"]) {
      put(`1.${k}.webp`);
      put(`${HASH}.${k}.webp`);
      put(`${YT}.${k}.webp`);
    }
    put(`${HASH2}.poster.webp`, "seed"); // same Video as 4.poster.webp: the integer-named file wins
    put(`4.poster.webp`, "own");
    put(`${"e".repeat(64)}.poster.webp`); // no Video
    put(`zzzzzzzzzzz.poster.webp`); // no Video
    put(`${V(9)}.poster.webp`); // already a uuid
    put("manifest.json");

    expect(renameLegacyThumbnails(db, dir)).toEqual({ integer: 3, contentHash: 2, youtubeId: 2 });
    const files = readdirSync(dir).sort();
    expect(files).toEqual(
      [
        `${V(1)}.poster.webp`, `${V(1)}.strip.webp`, `${byHash}.poster.webp`, `${byHash}.strip.webp`,
        `${byYt}.poster.webp`, `${byYt}.strip.webp`, `${V(4)}.poster.webp`, `${HASH2}.poster.webp`,
        `${"e".repeat(64)}.poster.webp`, "zzzzzzzzzzz.poster.webp", `${V(9)}.poster.webp`, "manifest.json",
      ].sort(),
    );
    expect(readFileSync(join(dir, `${byHash}.poster.webp`), "utf8")).toBe(`${HASH}.poster.webp`);
    expect(readFileSync(join(dir, `${V(4)}.poster.webp`), "utf8")).toBe("own");

    expect(renameLegacyThumbnails(db, dir)).toEqual({ integer: 0, contentHash: 0, youtubeId: 0 });
    expect(readdirSync(dir).sort()).toEqual(files);
  });

  test("a missing directory renames nothing", () => {
    const db = openDb(":memory:", MIGRATIONS);
    expect(renameLegacyThumbnails(db, "/nonexistent/thumbs")).toEqual({ integer: 0, contentHash: 0, youtubeId: 0 });
  });
});
