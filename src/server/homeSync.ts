// A Mac's side of "Resume and Favorites follow you" (docs/home-server-spec.md §6): every Resume and Favorite write
// goes to this Mac's library.db first, then to the Home Server through `home_outbox` (sent in order, kept while it
// cannot be reached); at connect and on each focus check this Mac pulls `GET /api/me/state?since=` and applies the
// newer rows. Favorites wait for the first-connect replace (§6.2). Never on a timer.
import { writeFileSync } from "node:fs";
import type { Db } from "./db";
import type { HomeServer } from "./homeServer";
import { log } from "./log";
import { applyFavorite, applyResume, favoriteOf, favoritesFile, resumeOf, Resolver } from "./meState";
import { newer, outboxKey, outboxPlan, type MeFavorite, type MeReplaceFavorites, type MeResume, type MeStateDto } from "../shared/meState";
import type { HomeSyncDto } from "../shared/types";

const TIMEOUT_MS = 4_000;

const getKey = (db: Db, key: string): string | null => (db.query("SELECT value FROM download_setting WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
const setKey = (db: Db, key: string, value: string | null) => {
  if (value == null) db.query("DELETE FROM download_setting WHERE key = ?").run(key);
  else db.query("INSERT INTO download_setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
};

interface OutboxRow {
  id: number;
  kind: "resume" | "favorite";
  key: string;
  body: string;
}

export class HomeSync {
  private flushing: Promise<void> | null = null;
  private error: string | null = null;
  constructor(
    private deps: {
      db: Db;
      home: Pick<HomeServer, "base" | "status">;
      /** This Mac's name, written into the Export Favorites… file. */
      machine: () => string;
      fetch?: typeof fetch;
    },
  ) {}

  private get db() {
    return this.deps.db;
  }
  private fetch(url: string, init: RequestInit = {}) {
    return (this.deps.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  }

  /** §6.2: the first-connect replace has run against the Home Server set now. */
  firstSyncDone(): boolean {
    const base = this.deps.home.base();
    return !!base && !!getKey(this.db, "home_server_first_sync_at") && getKey(this.db, "home_first_sync_base") === base;
  }

  status(): HomeSyncDto {
    return {
      firstSyncDone: this.firstSyncDone(),
      firstSyncAt: getKey(this.db, "home_server_first_sync_at"),
      outbox: (this.db.query("SELECT COUNT(*) n FROM home_outbox").get() as { n: number }).n,
      pulledAt: getKey(this.db, "home_state_pulled_at"),
      error: this.error,
    };
  }

  private enqueue(kind: "resume" | "favorite", key: string, body: MeResume | MeFavorite) {
    this.db.query("INSERT INTO home_outbox (kind, key, body, created_at) VALUES (?, ?, ?, ?)").run(kind, key, JSON.stringify(body), new Date().toISOString());
    void this.flush();
  }

  /** After a Resume write on this Mac (the browser or a TV on this Mac's Library Server, §6.3). */
  wroteResume(videoId: string): void {
    if (!this.deps.home.base()) return;
    const r = resumeOf(this.db, videoId);
    if (r) this.enqueue("resume", outboxKey("resume", r.video), r);
  }

  /** After a star or unstar on this Mac. Before the first-connect replace Favorites stay here (§6.2). */
  wroteFavorite(kind: "video" | "chapter", id: string): void {
    if (!this.firstSyncDone()) return;
    const f = favoriteOf(this.db, kind, id);
    if (f) this.enqueue("favorite", outboxKey("favorite", f.video, f.startMs), f);
  }

  /** The star of a Video only the Home Server has (a `home_video` row): kept in `home_me`, sent like any other. */
  starHomeOnly(video: { id: string; youtube_id: string | null; content_hash: string | null }, want: boolean | undefined): string | null {
    const cur = this.db.query("SELECT favorited_at FROM home_me WHERE video_id = ?").get(video.id) as { favorited_at: string | null } | null;
    const on = want ?? !cur?.favorited_at;
    if (on && cur?.favorited_at) return cur.favorited_at;
    const at = new Date().toISOString();
    const fav = on ? at : null;
    this.db
      .query("INSERT INTO home_me (video_id, favorited_at, favorite_at) VALUES (?, ?, ?) ON CONFLICT(video_id) DO UPDATE SET favorited_at = excluded.favorited_at, favorite_at = excluded.favorite_at")
      .run(video.id, fav, at);
    if (this.firstSyncDone()) {
      const f: MeFavorite = { video: { id: video.id, youtubeId: video.youtube_id, contentHash: video.content_hash }, startMs: null, favoritedAt: fav, favoriteAt: at };
      this.enqueue("favorite", outboxKey("favorite", f.video), f);
    }
    return fav;
  }

  /** Sends the outbox in order; stops at the first failure and keeps the rest for the next connect (§6.1, §9). */
  flush(): Promise<void> {
    return (this.flushing ??= this.doFlush().finally(() => (this.flushing = null)));
  }

  private async doFlush(): Promise<void> {
    const base = this.deps.home.base();
    if (!base) return;
    const rows = this.db.query("SELECT id, kind, key, body FROM home_outbox ORDER BY id").all() as OutboxRow[];
    const { send, superseded } = outboxPlan(rows);
    for (const id of superseded) this.db.query("DELETE FROM home_outbox WHERE id = ?").run(id);
    for (const r of send) {
      let status: number;
      try {
        status = (await this.fetch(`${base}/api/me/${r.kind}`, { method: "PUT", headers: { "content-type": "application/json" }, body: r.body })).status;
      } catch {
        this.error = "The Home Server could not be reached; the writes wait here";
        return;
      }
      // 2xx: delivered; 400/404/422: never deliverable (a Video the Home Server does not have answers 200 unknown).
      if (status < 300 || status === 400 || status === 404 || status === 422) {
        this.db.query("DELETE FROM home_outbox WHERE id = ?").run(r.id);
        continue;
      }
      this.error = `The Home Server refused a write (${status}); it waits here`;
      return;
    }
    this.error = null;
  }

  /** Pulls what changed on the Home Server since the last pull, and applies the newer rows here (§6.1). */
  async pull(): Promise<{ resume: number; favorites: number } | null> {
    const base = this.deps.home.base();
    if (!base) return null;
    const since = getKey(this.db, "home_state_base") === base ? getKey(this.db, "home_state_since") : null;
    let body: MeStateDto;
    try {
      const r = await this.fetch(`${base}/api/me/state${since ? `?since=${encodeURIComponent(since)}` : ""}`);
      if (!r.ok) {
        this.error = `Resume and Favorites did not come (${r.status})`;
        return null;
      }
      body = (await r.json()) as MeStateDto;
      if (!body || typeof body.now !== "string" || !Array.isArray(body.resume) || !Array.isArray(body.favorites)) throw new Error("shape");
    } catch {
      this.error = "Resume and Favorites did not come (no answer)";
      return null;
    }
    const favorites = this.firstSyncDone();
    const n = { resume: 0, favorites: 0 };
    const res = new Resolver(this.db);
    this.db.transaction(() => {
      for (const r of body.resume) {
        const a = applyResume(this.db, res, r);
        if (a === "applied") n.resume++;
        else if (a === "unknown") this.homeMe(r.video.id, { resume_s: r.resumeS, resume_at: r.resumeAt }, "resume_at", r.resumeAt);
      }
      if (favorites)
        for (const f of body.favorites) {
          const a = applyFavorite(this.db, res, f);
          if (a === "applied") n.favorites++;
          else if (a === "unknown" && f.startMs == null) this.homeMe(f.video.id, { favorited_at: f.favoritedAt, favorite_at: f.favoriteAt }, "favorite_at", f.favoriteAt);
        }
      setKey(this.db, "home_state_since", body.now);
      setKey(this.db, "home_state_base", base);
      setKey(this.db, "home_state_pulled_at", new Date().toISOString());
    })();
    this.error = null;
    if (n.resume || n.favorites) log(`Home Server: ${n.resume} Resume positions and ${n.favorites} Favorites were newer there`);
    return n;
  }

  /** The Home Server's own Videos' state (`home_me`), newest wins like the rest. */
  private homeMe(id: string, cols: Record<string, string | number | null>, atCol: "resume_at" | "favorite_at", at: string) {
    const cur = this.db.query(`SELECT ${atCol} AS at FROM home_me WHERE video_id = ?`).get(id) as { at: string | null } | null;
    if (!newer(at, cur?.at)) return;
    const keys = Object.keys(cols);
    this.db
      .query(`INSERT INTO home_me (video_id, ${keys.join(", ")}) VALUES (?, ${keys.map(() => "?").join(", ")}) ON CONFLICT(video_id) DO UPDATE SET ${keys.map((k) => `${k} = excluded.${k}`).join(", ")}`)
      .run(id, ...keys.map((k) => cols[k]!));
  }

  /** At connect and on each focus check (§6.1): the outbox first, then the pull. */
  async sync(): Promise<void> {
    if (!this.deps.home.base() || !this.deps.home.status().connected) return;
    await this.flush();
    await this.pull();
  }

  /**
   * First connect (§6.2): writes the Export Favorites… file to `path` (the caller chose it), then this Mac's Favorites
   * replace the Home Server's in one request (which backs its own up first). Nothing is sent unless the file was saved.
   */
  async firstSync(path: string): Promise<{ ok: true; exported: number; replaced: { starred: number; unstarred: number; unknown: number; backup: string } } | { ok: false; error: string }> {
    const base = this.deps.home.base();
    if (!base) return { ok: false, error: "No Home Server is set" };
    const file = favoritesFile(this.db, this.deps.machine());
    try {
      writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
    } catch (e) {
      return { ok: false, error: `The file could not be saved: ${(e as Error).message}` };
    }
    const homeOnly = this.db.query("SELECT m.video_id, m.favorited_at FROM home_me m WHERE m.favorited_at IS NOT NULL").all() as { video_id: string; favorited_at: string }[];
    const body: MeReplaceFavorites = {
      favorites: [
        ...file.favorites.map((f) => ({ video: { id: f.id, youtubeId: f.youtubeId, contentHash: f.contentHash }, startMs: f.startMs, favoritedAt: f.favoritedAt })),
        ...homeOnly.map((h) => ({ video: { id: h.video_id, youtubeId: null, contentHash: null }, startMs: null, favoritedAt: h.favorited_at })),
      ],
    };
    let answer: { starred: number; unstarred: number; unknown: number; backup: string };
    try {
      const r = await this.fetch(`${base}/api/me/favorites`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) return { ok: false, error: `The Home Server refused the Favorites (${r.status})` };
      answer = (await r.json()) as typeof answer;
    } catch {
      return { ok: false, error: "The Home Server could not be reached" };
    }
    setKey(this.db, "home_server_first_sync_at", new Date().toISOString());
    setKey(this.db, "home_first_sync_base", base);
    // Favorites written before the replace are in it: nothing older may follow it to the Home Server
    this.db.query("DELETE FROM home_outbox WHERE kind = 'favorite'").run();
    log(`Home Server: first connect, this Mac's ${file.favorites.length} Favorites replaced the Home Server's (its backup: ${answer.backup})`);
    await this.pull();
    return { ok: true, exported: file.favorites.length, replaced: answer };
  }

  /** Import Favorites… (§6.2) changed these: they follow like any star, once the first-connect replace has run. */
  imported(applied: readonly MeFavorite[]): void {
    if (!this.firstSyncDone()) return;
    for (const f of applied)
      this.db.query("INSERT INTO home_outbox (kind, key, body, created_at) VALUES ('favorite', ?, ?, ?)").run(outboxKey("favorite", f.video, f.startMs), JSON.stringify(f), new Date().toISOString());
    void this.flush();
  }
}
