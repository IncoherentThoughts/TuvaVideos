import { openDb } from "/home/user/TuvaVideos/src/server/db";
import { suggestSongsFromTitles } from "/home/user/TuvaVideos/src/server/songSuggest";
import { suggestArtists } from "/home/user/TuvaVideos/src/server/artistSuggest";
import { applyPerformanceDefaults } from "/home/user/TuvaVideos/src/server/defaults";
import { fillLatinTitles } from "/home/user/TuvaVideos/src/server/latin";
const db = openDb(":memory:", "/home/user/TuvaVideos/migrations");
const words = ["Алаш","Хөөмей","Тыва","Чурумей","Кожамык","Сыгыт","Каргыраа","Байлак","Ыры","Чаа"];
const w = (i: number) => words[i % 10] + " " + words[(i * 7) % 10] + " " + i;
db.transaction(() => {
  for (let i = 0; i < 3000; i++) db.query("INSERT INTO archive_song (id, name, slug, alternate_titles) VALUES (?, ?, ?, '[]')").run("s" + i, w(i), "s" + i);
  for (let i = 0; i < 600; i++) db.query("INSERT INTO archive_artist (id, name, is_hidden, is_various_artists) VALUES (?, ?, 0, 0)").run("a" + i, "Artist " + w(i * 3));
  for (let i = 0; i < 3000; i++) db.query("INSERT INTO archive_performance (id, song_id, url, display_order, is_highlighted, youtube_id) VALUES (?, ?, '', 0, 0, ?)").run("p" + i, "s" + i, ("y" + i).padEnd(11, "x"));
  const now = new Date().toISOString();
  for (let i = 0; i < 1700; i++) { db.query("INSERT INTO videos (id, youtube_id, title, type, created_at, updated_at) VALUES (?, ?, ?, 'song', ?, ?)").run("v" + i, ("z" + i).padEnd(11, "q"), w(i * 13) + " live", now, now); db.query("INSERT INTO video_local (video_id) VALUES (?)").run("v" + i); }
})();
for (const [name, fn] of [["defaults", () => applyPerformanceDefaults(db, { videoId: "v5" })], ["songs", () => suggestSongsFromTitles(db, { videoId: "v5" })], ["artists", () => suggestArtists(db, { videoId: "v5" })], ["latin", () => fillLatinTitles(db, { videoId: "v5" })]] as const) {
  const t = performance.now(); for (let k = 0; k < 20; k++) (fn as any)(); console.log(name, "per new Video ms", ((performance.now() - t) / 20).toFixed(1));
}
for (const [n, f] of [["songs", () => suggestSongsFromTitles(db)], ["artists", () => suggestArtists(db)], ["defaults", () => applyPerformanceDefaults(db)]] as const) { const t = performance.now(); (f as any)(); console.log("full", n, (performance.now() - t).toFixed(0), "ms"); }
import { rebuildSearchIndex } from "/home/user/TuvaVideos/src/server/search"; { const t = performance.now(); rebuildSearchIndex(db); console.log("search rebuild", (performance.now()-t).toFixed(0)); }
