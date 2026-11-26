// This Mac's Home Server (docs/home-server-spec.md §4.1, §5.1): the stored setting (an address, or "This Mac is the
// Home Server"), its connection state, and the home index fetched from it into `home_copy` / `home_video`.
// The browser never calls another machine: everything goes through this Mac's localhost app.
import type { Db } from "./db";
import type { HomeServerTarget } from "./homeApprovals";
import { log } from "./log";
import { HOME_HEALTH_STALE_MS, HOME_INDEX_STALE_MS, homeBase, matchHome, type HomeIndexChapter, type HomeIndexDto, type HomeIndexVideo, type Identity } from "../shared/homeIndex";
import type { HomeStatusDto, HomeTestDto } from "../shared/types";

const TIMEOUT_MS = 4_000;
const INDEX_TIMEOUT_MS = 30_000;

const getKey = (db: Db, key: string): string | null => (db.query("SELECT value FROM download_setting WHERE key = ?").get(key) as { value: string } | null)?.value ?? null;
const setKey = (db: Db, key: string, value: string | null) => {
  if (value == null) db.query("DELETE FROM download_setting WHERE key = ?").run(key);
  else db.query("INSERT INTO download_setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
};

/** A `home_video` row as the grid shows it. */
export interface HomeVideoRow {
  id: string;
  youtube_id: string | null;
  content_hash: string | null;
  shared: number;
  title: string;
  title_latin: string | null;
  type: string;
  created_at: string;
  thumb: string | null;
  chapters: string;
  /** From `home_me` (§6): the Home Server's Favorite and Resume of it. */
  me_favorited_at?: string | null;
  me_resume_s?: number | null;
}

/** A Home Server Copy, as stored. */
export interface HomeCopyRow {
  id: number;
  video_id: string;
  youtube_id: string | null;
  content_hash: string | null;
  size: number;
  container: string | null;
  video_codec: string | null;
  audio_codec: string | null;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  available: number;
  playback: "native" | "remux" | "transcode";
}

/** What the grid needs from the home index, for this Mac's Videos as they are now. */
export interface HomeView {
  /** This Mac's Video id → the Home Server's usable Copies of it. */
  matched: Map<string, HomeCopyRow[]>;
  /** Home Server Videos this Mac does not know, with their usable Copies (none hidden: they have at least one). */
  homeOnly: { row: HomeVideoRow; copies: HomeCopyRow[]; chapters: HomeIndexChapter[] }[];
}

const EMPTY_VIEW: HomeView = { matched: new Map(), homeOnly: [] };

/** Pure: an index answer, checked enough to store (unknown shapes are refused, not half-stored). */
export function parseHomeIndex(body: unknown): HomeIndexDto | null {
  const b = body as HomeIndexDto | null;
  if (!b || typeof b.server !== "string" || !Array.isArray(b.videos)) return null;
  for (const v of b.videos) if (!v || typeof v.id !== "string" || typeof v.title !== "string" || !Array.isArray(v.copies)) return null;
  return b;
}

/** Replace `home_copy` and `home_video` wholesale with an index (§5.1). Unmatched Home Server Videos go to `home_video`. */
export function storeHomeIndex(db: Db, index: HomeIndexDto, local: readonly Identity[]): { videos: number; copies: number; homeOnly: number } {
  const matched = matchHome(local, index.videos);
  let copies = 0;
  let homeOnly = 0;
  db.transaction(() => {
    db.query("DELETE FROM home_copy").run();
    db.query("DELETE FROM home_video").run();
    const ic = db.prepare("INSERT OR REPLACE INTO home_copy (id, video_id, youtube_id, content_hash, size, container, video_codec, audio_codec, width, height, duration_s, available, playback) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    const iv = db.prepare("INSERT OR REPLACE INTO home_video (id, youtube_id, content_hash, shared, title, title_latin, type, created_at, thumb, chapters) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const v of index.videos) {
      for (const c of v.copies) {
        const playback = c.playback === "native" || c.playback === "remux" ? c.playback : "transcode";
        ic.run(c.id, v.id, v.youtubeId ?? null, v.contentHash ?? null, c.size ?? 0, c.container ?? null, c.videoCodec ?? null, c.audioCodec ?? null, c.width ?? null, c.height ?? null, c.durationS ?? null, c.available ? 1 : 0, playback);
        copies++;
      }
      if (!matched.has(v.id)) {
        iv.run(v.id, v.youtubeId ?? null, v.contentHash ?? null, v.shared ? 1 : 0, v.title, v.titleLatin ?? null, v.type ?? "other", v.createdAt ?? new Date(0).toISOString(), v.thumb ?? null, JSON.stringify(v.chapters ?? []));
        homeOnly++;
      }
    }
  })();
  return { videos: index.videos.length, copies, homeOnly };
}

/**
 * The grid's view of the stored index against this Mac's Videos now (pure over the rows). Matching runs again here, so
 * a Video that arrived on this Mac since the fetch takes its Home Server twin's place; Copies whose Root is not mounted
 * on the Home Server do not count (§2.2: Unmounted there, not On the Home Server).
 */
export function homeView(local: readonly Identity[], copies: readonly HomeCopyRow[], homeVideos: readonly HomeVideoRow[]): HomeView {
  const byRemote = new Map<string, HomeCopyRow[]>();
  for (const c of copies) {
    if (!c.available) continue;
    const arr = byRemote.get(c.video_id);
    if (arr) arr.push(c);
    else byRemote.set(c.video_id, [c]);
  }
  const remote: Identity[] = [];
  const seen = new Set<string>();
  for (const c of copies) if (!seen.has(c.video_id)) (seen.add(c.video_id), remote.push({ id: c.video_id, youtubeId: c.youtube_id, contentHash: c.content_hash }));
  const m = matchHome(local, remote);
  const matched = new Map<string, HomeCopyRow[]>();
  for (const [rid, lid] of m) {
    const cs = byRemote.get(rid);
    if (cs?.length) matched.set(lid, cs);
  }
  const homeOnly: HomeView["homeOnly"] = [];
  for (const row of homeVideos) {
    if (m.has(row.id)) continue;
    const cs = byRemote.get(row.id);
    if (!cs?.length) continue;
    let chapters: HomeIndexChapter[] = [];
    try {
      chapters = JSON.parse(row.chapters) as HomeIndexChapter[];
    } catch {}
    homeOnly.push({ row, copies: cs, chapters });
  }
  return { matched, homeOnly };
}

interface Check {
  at: number;
  ok: boolean;
  server: string | null;
  version: string | null;
  drive: string | null;
  error: string | null;
}

export class HomeServer {
  private check: Check | null = null;
  private inflight: Promise<HomeStatusDto> | null = null;

  constructor(
    private deps: {
      db: Db;
      /** The Library Server's port, for an address given without one. */
      defaultPort: number;
      /** This Mac's Identity list (its own Videos), for matching at fetch. */
      localIdentities: () => Identity[];
      env?: Record<string, string | undefined>;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {}

  private get env() {
    return this.deps.env ?? process.env;
  }
  private now() {
    return this.deps.now?.() ?? Date.now();
  }
  private fetch(url: string, init: RequestInit = {}, ms = TIMEOUT_MS) {
    return (this.deps.fetch ?? fetch)(url, { ...init, signal: AbortSignal.timeout(ms) });
  }

  /** The stored Home Server field (§4.1). */
  get address(): string | null {
    return getKey(this.deps.db, "home_server");
  }
  /** "This Mac is the Home Server" (§4.1): health says `home: true`, and this Mac never connects to itself. */
  get self(): boolean {
    return getKey(this.deps.db, "home_self") === "1";
  }
  /** `TUVA_HOME_SERVER` (tests and smoke runs) overrides the stored field. */
  private get override(): string | null {
    return this.env.TUVA_HOME_SERVER?.trim() || null;
  }

  /** The Home Server's Library Server base URL, or null when none is set (or this Mac is the Home Server). */
  base(): string | null {
    if (this.self) return null;
    const a = this.override ?? this.address;
    return a ? homeBase(a, this.deps.defaultPort) : null;
  }

  /** For the approvals proxy (§3.2). */
  readonly target: HomeServerTarget = () => this.base();

  status(): HomeStatusDto {
    const base = this.base();
    const c = this.check;
    const at = getKey(this.deps.db, "home_index_at");
    const count = (sql: string) => (this.deps.db.query(sql).get() as { n: number }).n;
    return {
      configured: base != null,
      self: this.self,
      address: this.address,
      override: this.override != null,
      base,
      connected: !!base && !!c?.ok,
      checkedAt: c ? new Date(c.at).toISOString() : null,
      server: c?.server ?? getKey(this.deps.db, "home_index_server"),
      version: c?.version ?? null,
      drive: c?.drive === "mounted" || c?.drive === "unmounted" ? c.drive : null,
      error: c && !c.ok ? c.error : null,
      index: at ? { at, videos: count("SELECT COUNT(DISTINCT video_id) n FROM home_copy"), copies: count("SELECT COUNT(*) n FROM home_copy"), homeOnly: count("SELECT COUNT(*) n FROM home_video") } : null,
    };
  }

  /** Save the field and/or the toggle. A changed target drops the old index and the old connection state. */
  set(p: { address?: string | null; self?: boolean }): { ok: true; status: HomeStatusDto } | { ok: false; error: string } {
    const before = this.base();
    if (p.address !== undefined) {
      const a = p.address?.trim() || null;
      if (a && !homeBase(a, this.deps.defaultPort)) return { ok: false, error: "Not a Tailscale name or address" };
      setKey(this.deps.db, "home_server", a);
    }
    if (p.self !== undefined) setKey(this.deps.db, "home_self", p.self ? "1" : null);
    if (this.base() !== before) this.forget();
    return { ok: true, status: this.status() };
  }

  /** Drop the stored index and connection state (another Home Server, none, or this Mac itself). */
  forget(): void {
    this.check = null;
    this.deps.db.transaction(() => {
      this.deps.db.query("DELETE FROM home_copy").run();
      this.deps.db.query("DELETE FROM home_video").run();
      this.deps.db.query("DELETE FROM home_me").run(); // §6: the old Home Server's own Videos' Resume and Favorites
      for (const k of ["home_index_etag", "home_index_at", "home_index_server"]) setKey(this.deps.db, k, null);
    })();
  }

  /** Test (§4.1): ask an address's health, without saving it. */
  async test(address: string): Promise<HomeTestDto> {
    const base = homeBase(address, this.deps.defaultPort);
    if (!base) return { ok: false, base: null, error: "Not a Tailscale name or address" };
    try {
      const r = await this.fetch(`${base}/api/health`);
      const h = (await r.json().catch(() => null)) as { app?: string; name?: string; home?: boolean; version?: string; drive?: string } | null;
      if (!r.ok || !h || typeof h.app !== "string" || !h.app.startsWith("TuvaVideos")) return { ok: false, base, error: "That address answers, but not as a TuvaVideos Library Server" };
      return { ok: true, base, name: h.name ?? null, version: h.version ?? null, drive: h.drive === "mounted" ? "mounted" : "unmounted", home: !!h.home };
    } catch {
      return { ok: false, base, error: "No answer (is the Library Server on there, and Tailscale up on both Macs?)" };
    }
  }

  /**
   * Check the connection and fetch the index (§4.1, §5.1). `force`: at connect and from the refresh button; otherwise
   * (window focus) health is asked again only after 60 s and the index only after 10 minutes. Never on a timer.
   */
  refresh(o: { force?: boolean } = {}): Promise<HomeStatusDto> {
    return (this.inflight ??= this.doRefresh(!!o.force).finally(() => (this.inflight = null)));
  }

  private async doRefresh(force: boolean): Promise<HomeStatusDto> {
    const base = this.base();
    if (!base) return this.status();
    const now = this.now();
    const at = Date.parse(getKey(this.deps.db, "home_index_at") ?? "");
    const indexStale = force || !Number.isFinite(at) || now - at >= HOME_INDEX_STALE_MS || !this.check?.ok;
    const healthStale = force || !this.check || now - this.check.at >= HOME_HEALTH_STALE_MS;
    if (healthStale) {
      const t = await this.test(base);
      this.check = t.ok ? { at: now, ok: true, server: t.name, version: t.version, drive: t.drive, error: null } : { at: now, ok: false, server: this.check?.server ?? null, version: null, drive: null, error: t.error };
    }
    if (this.check?.ok && indexStale) await this.fetchIndex(base, now);
    return this.status();
  }

  private async fetchIndex(base: string, now: number): Promise<void> {
    const etag = getKey(this.deps.db, "home_index_etag");
    try {
      const r = await this.fetch(`${base}/api/home/index`, { headers: etag ? { "if-none-match": etag } : {} }, INDEX_TIMEOUT_MS);
      if (r.status === 304) return setKey(this.deps.db, "home_index_at", new Date(now).toISOString());
      if (r.status === 403) {
        this.check = { at: now, ok: false, server: this.check?.server ?? null, version: null, drive: null, error: "The Home Server does not know this Mac yet (Tailscale with the same user, or Allow on it)" };
        return;
      }
      const index = r.ok ? parseHomeIndex(await r.json()) : null;
      if (!index) {
        this.check = { at: now, ok: false, server: this.check?.server ?? null, version: null, drive: null, error: `The home index did not come (${r.status})` };
        return;
      }
      const n = storeHomeIndex(this.deps.db, index, this.deps.localIdentities());
      setKey(this.deps.db, "home_index_etag", r.headers.get("etag"));
      setKey(this.deps.db, "home_index_at", new Date(now).toISOString());
      setKey(this.deps.db, "home_index_server", index.server);
      log(`Home Server ${index.server}: ${n.videos} Videos, ${n.copies} Copies, ${n.homeOnly} not on this Mac`);
    } catch {
      this.check = { at: now, ok: false, server: this.check?.server ?? null, version: null, drive: null, error: "The home index did not come (no answer)" };
    }
  }

  /** The grid's view: empty unless connected (§9: unreachable, On the Home Server goes back to Not on this machine). */
  view(local: readonly Identity[]): HomeView {
    if (!this.base() || !this.check?.ok) return EMPTY_VIEW;
    const copies = this.deps.db.query("SELECT * FROM home_copy").all() as HomeCopyRow[];
    if (!copies.length) return EMPTY_VIEW;
    // §6: with the Home Server's Resume and Favorite of its own Videos (`home_me`)
    const rows = this.deps.db.query("SELECT h.*, m.favorited_at AS me_favorited_at, m.resume_s AS me_resume_s FROM home_video h LEFT JOIN home_me m ON m.video_id = h.id").all() as HomeVideoRow[];
    return homeView(local, copies, rows);
  }
}

export type { HomeIndexVideo };
