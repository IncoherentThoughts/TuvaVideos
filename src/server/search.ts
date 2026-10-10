import type { Db } from "./db";

/** ASCII fold for `text_folded` (data-model.md Search): ŋ -> ng, ö/ü -> o/u, and x also indexed as kh. */
export function foldText(s: string): string {
  const base = s
    .toLowerCase()
    .replace(/ŋ/g, "ng")
    .replace(/ö/g, "o")
    .replace(/ü/g, "u")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "");
  return base.includes("x") ? `${base} ${base.replace(/x/g, "kh")}` : base;
}

/** Ticket #22 indexes Video titles only; #23 owns the full rebuild (chapters, artists, songs, lyrics). */
export function rebuildVideoSearch(db: Db) {
  const rows = db.query("SELECT id, title, title_latin FROM video").all() as { id: number; title: string; title_latin: string | null }[];
  const ins = db.prepare("INSERT INTO search (kind, ref_id, text, text_folded) VALUES ('video', ?, ?, ?)");
  db.transaction(() => {
    db.exec("DELETE FROM search WHERE kind = 'video'");
    for (const r of rows) {
      const text = r.title_latin ? `${r.title} ${r.title_latin}` : r.title;
      ins.run(r.id, text, foldText(text));
    }
  })();
}
