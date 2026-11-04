// Bracket tags that are not YouTube ids (audit DB-9) no longer merge unrelated files into one Video.
import { expect, test } from "bun:test";
import { parseFilename } from "../src/server/filename";

test("resolution, year and word tags are not ids; the title keeps them", () => {
  for (const tag of ["1080p60_HDR", "720p_remux1", "Khoomei2019", "Ustuu-Huree", "Live_Tuvan", "HDR-Version"]) {
    const p = parseFilename(`Kongurei [${tag}].mp4`);
    expect(p.youtubeId).toBeNull();
    expect(p.title).toBe(`Kongurei [${tag}]`);
  }
});

test("real-looking ids still parse", () => {
  for (const id of ["dQw4w9WgXcQ", "aaaaaaaaaaa", "a-b_c-d_e-f", "Xy_9-kLmN0p", "-2019abcdeF"]) expect(parseFilename(`x [${id}].mkv`).youtubeId).toBe(id);
});
