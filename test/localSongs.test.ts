// Local Songs and Local Versions: the plain-text <-> HTML converter, the local_song/local_version tables behind the
// song_all/version_all views, and the create/edit/delete rules.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { openDb } from "../src/server/db";
import { patchVideo } from "../src/server/edit";
import { createLocalSong, createLocalVersion, deleteLocalSong, deleteLocalVersion, patchLocalSong, patchLocalVersion } from "../src/server/localSongs";
import { insertVideo, V } from "./helpers/seed";
import { rebuildSearchIndex, runSearch as search } from "../src/server/search";
import { listSongs, songDto, songRef, versionsOf } from "../src/server/songs";
import { footnotesToText, htmlToPlain, linesToHtml, parseFootnotesText } from "../src/shared/lyrics/plain";
import { numberLines, parseHtmlToLines } from "../src/shared/lyrics/normalize";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const env = { isRootAvailable: () => true };

describe("plain text <-> lyric HTML", () => {
  test("lines, stanza breaks and Markers", () => {
    const html = linesToHtml("Line one[1]\nLine two\n\n\nLine three [12]\n");
    expect(html).toBe('<p>Line one<sup data-fn="1">1</sup></p>\n<p>Line two</p>\n<p class="ln-blank"><br></p>\n<p class="ln-blank"><br></p>\n<p>Line three <sup data-fn="12">12</sup></p>');
    const lines = numberLines(parseHtmlToLines(html!));
    expect(lines.filter((l) => !l.blank).map((l) => l.n)).toEqual([1, 2, 3]);
    expect(htmlToPlain(html)).toBe("Line one[1]\nLine two\n\n\nLine three [12]");
  });
  test("HTML in the text is escaped, not kept", () => {
    expect(linesToHtml("<b>bold</b> & co")).toBe("<p>&lt;b&gt;bold&lt;/b&gt; &amp; co</p>");
    expect(htmlToPlain("<p>&lt;b&gt;bold&lt;/b&gt; &amp; co</p>")).toBe("<b>bold</b> & co");
  });
  test("empty text is null; archive HTML with tags strips to plain", () => {
    expect(linesToHtml("  \n\n ")).toBeNull();
    expect(htmlToPlain('<p><em>Ай</em>-ла<sup data-fn="2" class="footnote-ref">2</sup></p><p>&nbsp;</p><p>Ой</p>')).toBe("Ай-ла[2]\n\nОй");
  });
  test("footnotes round-trip", () => {
    const fns = parseFootnotesText("1: first\n2. second line\n   continues\n\nnot a footnote\n3) third");
    expect(fns).toEqual([{ id: 1, text: "first" }, { id: 2, text: "second line continues not a footnote" }, { id: 3, text: "third" }]);
    expect(footnotesToText([{ id: 1, text: "a <i>b</i> &amp; c" }])).toBe("1: a b & c");
  });
});

describe("Local Songs and Versions", () => {
  const open = () => {
    const db = openDb(":memory:", MIGRATIONS);
    insertVideo(db, { id: 1, youtube_id: "aaaaaaaaaaa", title: "Концерт", created_at: "x" });
    db.exec("INSERT INTO archive_song (id, name, slug, english_name) VALUES ('m1', 'Чашпы-Хем', 'chashpy-khem', 'Chashpy River')");
    db.exec("INSERT INTO archive_version (id, song_id, label, display_order, cyrillic) VALUES ('mv1', 'm1', 'Complete', 1, '<p>Архив</p>')");
    rebuildSearchIndex(db);
    return db;
  };

  test("create: trimmed, deduplicated against Mirror and Local names, listed and searchable at once", () => {
    const db = open();
    const r = createLocalSong(db, { name: "  Ак   Хем ", englishName: "White River" });
    expect(r.ok && r.value.created && r.value.local).toBe(true);
    const id = (r as any).value.id as string;
    expect(createLocalSong(db, { name: "чашпы-хем" })).toMatchObject({ ok: true, value: { id: "m1", created: false, local: false } });
    expect(createLocalSong(db, { name: "ак хем" })).toMatchObject({ ok: true, value: { id, created: false, local: true } });
    expect(createLocalSong(db, { name: "" }).ok).toBe(false);

    expect(songRef(db, id)).toEqual({ id, name: "Ак Хем", englishName: "White River", hidden: false, local: true, proposed: false, versions: [] });
    expect(songRef(db, "m1")?.local).toBe(false);
    expect(songDto(db, id)?.local).toBe(true);
    // a Local Song is listed even before a Video points at it; the Mirror Song is not until one does
    expect(listSongs(db).map((s) => [s.id, s.local])).toEqual([[id, true]]);
    const hit = search(db, env, "ak khem").groups.find((g) => g.key === "songs")!.rows[0];
    expect(hit).toMatchObject({ kind: "song", id, local: true });
    // a Video may point at it, and a dangling-ref count does not count it
    expect(patchVideo(db, V(1), { songId: id })).toEqual({ ok: true });
    expect(db.query("SELECT kind FROM song_all WHERE id = (SELECT song_id FROM video_full WHERE id = ?)").get(V(1))).toEqual({ kind: "local" }); // not dangling
    expect(listSongs(db).find((s) => s.id === id)?.videoCount).toBe(1);
  });

  test("rename and delete rules", () => {
    const db = open();
    const id = (createLocalSong(db, { name: "Ак Хем" }) as any).value.id as string;
    expect(patchLocalSong(db, id, { name: "Чашпы-Хем" })).toMatchObject({ ok: false, status: 409 });
    expect(patchLocalSong(db, "m1", { name: "x" })).toMatchObject({ ok: false, status: 409 });
    expect(patchLocalSong(db, id, { name: "Кара Хем", englishName: null })).toEqual({ ok: true, value: { id, name: "Кара Хем", englishName: null } });
    expect(search(db, env, "kara khem").groups.find((g) => g.key === "songs")!.rows[0]).toMatchObject({ id, name: "Кара Хем" });
    patchVideo(db, V(1), { songId: id });
    expect(deleteLocalSong(db, id)).toMatchObject({ ok: false, status: 409 });
    patchVideo(db, V(1), { songId: null });
    createLocalVersion(db, id, { label: "Complete", scripts: { cyrillic: { html: "<p>Сөс</p>", footnotes: [] } } });
    expect(deleteLocalSong(db, id)).toEqual({ ok: true, value: { deleted: true } });
    expect(songRef(db, id)?.name).toBeNull();
    expect(db.query("SELECT COUNT(*) n FROM local_version").get()).toEqual({ n: 0 });
    expect(search(db, env, "kara khem").groups.find((g) => g.key === "songs")?.rows ?? []).toEqual([]);
    expect(deleteLocalSong(db, "m1")).toMatchObject({ ok: false, status: 409 });
  });

  test("a Local Version on a Mirror Song: sanitized, ordered after the archive's, labelled uniquely, indexed", () => {
    const db = open();
    const r = createLocalVersion(db, "m1", {
      label: " Live 2024 ",
      scripts: {
        cyrillic: { html: '<p>Кара<sup data-fn="1">1</sup> <script>x()</script>дыт</p>', footnotes: [{ id: 1, text: "note <a href=x>a</a>" }] },
        translation: { html: "<p>Black larch</p>", footnotes: [] },
        transliteration: { html: "   ", footnotes: [] },
      },
    });
    expect(r.ok).toBe(true);
    const vid = (r as any).value.id as string;
    const vs = versionsOf(db, "m1");
    expect(vs.map((v) => [v.label, v.local])).toEqual([["Complete", false], ["Live 2024", true]]);
    expect(vs[1]!.scripts.cyrillic.html).toBe('<p>Кара<sup data-fn="1">1</sup> дыт</p>');
    expect(vs[1]!.scripts.cyrillic.footnotes).toEqual([{ id: 1, text: "note a" }]);
    expect(vs[1]!.scripts.transliteration.html).toBe("");
    expect(songRef(db, "m1")?.versions).toEqual([{ id: "mv1", label: "Complete", local: false, proposed: false }, { id: vid, label: "Live 2024", local: true, proposed: false }]);
    expect(createLocalVersion(db, "m1", { label: "complete" })).toMatchObject({ ok: false, status: 409 });
    expect(createLocalVersion(db, "nope", { label: "x" })).toMatchObject({ ok: false, status: 404 });
    // the lyric line is searchable and resolves to the Song
    const hit = search(db, env, "black larch").groups.find((g) => g.key === "songs")!.rows[0];
    expect(hit).toMatchObject({ kind: "song", id: "m1", viaLyrics: true });
    // a Video may point at the Local Version
    patchVideo(db, V(1), { songId: "m1" });
    expect(patchVideo(db, V(1), { versionId: vid })).toEqual({ ok: true });
    expect(db.query("SELECT kind FROM version_all WHERE id = (SELECT version_id FROM video_full WHERE id = ?)").get(V(1))).toEqual({ kind: "local" });
    expect(listSongs(db).find((s) => s.id === "m1")).toMatchObject({ versionCount: 2, localVersionCount: 1, local: false });
  });

  test("edit and delete a Local Version; the archive's are refused", () => {
    const db = open();
    const vid = (createLocalVersion(db, "m1", { label: "Live", scripts: { cyrillic: { html: "<p>Бир</p>", footnotes: [] } } }) as any).value.id as string;
    expect(patchLocalVersion(db, vid, { label: "Complete" })).toMatchObject({ ok: false, status: 409 });
    expect(patchLocalVersion(db, vid, { label: "Live 2", scripts: { cyrillic: null, translation: { html: "<p>One</p>", footnotes: [] } } })).toEqual({ ok: true, value: { id: vid } });
    const v = versionsOf(db, "m1")[1]!;
    expect([v.label, v.scripts.cyrillic.html, v.scripts.translation.html]).toEqual(["Live 2", "", "<p>One</p>"]);
    expect(search(db, env, "бир").groups.find((g) => g.key === "songs")?.rows ?? []).toEqual([]);
    expect(patchLocalVersion(db, "mv1", { label: "x" })).toMatchObject({ ok: false, status: 409 });
    expect(deleteLocalVersion(db, "mv1")).toMatchObject({ ok: false, status: 409 });
    patchVideo(db, V(1), { songId: "m1", versionId: vid });
    expect(deleteLocalVersion(db, vid)).toEqual({ ok: true, value: { deleted: true } });
    expect(db.query("SELECT song_id, version_id FROM videos WHERE id = ?").get(V(1))).toEqual({ song_id: "m1", version_id: null });
    expect(versionsOf(db, "m1").length).toBe(1);
  });
});

describe("stacked filters on the Songs group", () => {
  test("#fav narrows Songs to those a Favorite Video performs, and their Video lists", () => {
    const db = openDb(":memory:", MIGRATIONS);
    db.exec("INSERT INTO archive_song (id, name, slug) VALUES ('m1', 'Чавыдак', 'chavydak'), ('m2', 'Чавыдак-2', 'chavydak-2')");
    insertVideo(db, { id: 1, youtube_id: "aaaaaaaaaaa", title: "A", created_at: "x", song_id: "m1", favorited_at: "x" });
    insertVideo(db, { id: 2, youtube_id: "bbbbbbbbbbb", title: "B", created_at: "x", song_id: "m1" });
    insertVideo(db, { id: 3, youtube_id: "ccccccccccc", title: "C", created_at: "x", song_id: "m2" });
    rebuildSearchIndex(db);
    const songs = (q: string) => search(db, env, q).groups.find((g) => g.key === "songs")?.rows ?? [];
    expect(songs("#songs chavydak").map((r) => r.id).sort()).toEqual(["m1", "m2"]);
    const fav = songs("#songs #fav chavydak");
    expect(fav.map((r) => r.id)).toEqual(["m1"]);
    expect((fav[0] as any).videos.map((v: any) => v.id)).toEqual([V(1)]);
  });
});
