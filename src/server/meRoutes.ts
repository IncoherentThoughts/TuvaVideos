// The routes of "Resume and Favorites follow you" (docs/home-server-spec.md §6, §2.3).
// On the Home Server: `GET /api/me/state?since=`, `PUT /api/me/resume`, `PUT /api/me/favorite`, and the first-connect
// replace `PUT /api/me/favorites` (Approved Macs only through the Library Server: route kind `mac`).
// On a Mac (its own pages): the sync state, the first-connect Export Favorites… and replace, Export / Import Favorites….
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db";
import type { HomeSync } from "./homeSync";
import { log } from "./log";
import { applyFavorite, applyResume, favoritesFile, importFavorites, replaceFavorites, Resolver, stateSince } from "./meState";
import { run } from "./proc";
import { backupName, parseFavoritesFile, parseIdentity, type MeFavorite, type MeResume } from "../shared/meState";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function body(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const isTime = (x: unknown): x is string => typeof x === "string" && Number.isFinite(Date.parse(x));

function parseResume(b: Record<string, unknown> | null): MeResume | null {
  const video = parseIdentity(b?.video);
  if (!b || !video || !isTime(b.resumeAt)) return null;
  if (b.resumeS !== null && (typeof b.resumeS !== "number" || !Number.isFinite(b.resumeS) || b.resumeS < 0)) return null;
  return { video, resumeS: b.resumeS as number | null, resumeAt: b.resumeAt };
}

function parseFavorite(b: Record<string, unknown> | null): MeFavorite | null {
  const video = parseIdentity(b?.video);
  if (!b || !video || !isTime(b.favoriteAt)) return null;
  if (b.favoritedAt !== null && !isTime(b.favoritedAt)) return null;
  if (b.startMs != null && (typeof b.startMs !== "number" || !Number.isInteger(b.startMs) || b.startMs < 0)) return null;
  return { video, startMs: (b.startMs as number | null | undefined) ?? null, favoritedAt: b.favoritedAt as string | null, favoriteAt: b.favoriteAt };
}

/** The Finder's "choose file name" (macOS): where Export Favorites… saves. Null: cancelled. */
async function chooseSavePath(): Promise<{ path: string } | { cancelled: true } | { error: string }> {
  if (process.platform !== "darwin") return { error: "the save dialog is only available on macOS" };
  const day = new Date().toISOString().slice(0, 10);
  const r = await run("osascript", ["-e", 'tell application "System Events" to activate', "-e", `tell application "System Events" to return POSIX path of (choose file name with prompt "Export Favorites as" default name "TuvaVideos Favorites ${day}.json")`], { timeout: 600_000 });
  if (r.code === 0) return { path: r.out.trim() };
  if (/-128|cancel/i.test(r.err)) return { cancelled: true };
  return { error: r.err.trim() || "the save dialog failed" };
}

async function chooseOpenPath(): Promise<{ path: string } | { cancelled: true } | { error: string }> {
  if (process.platform !== "darwin") return { error: "the file dialog is only available on macOS" };
  const r = await run("osascript", ["-e", 'tell application "System Events" to activate', "-e", 'tell application "System Events" to return POSIX path of (choose file with prompt "Import which Favorites file?")'], { timeout: 600_000 });
  if (r.code === 0) return { path: r.out.trim() };
  if (/-128|cancel/i.test(r.err)) return { cancelled: true };
  return { error: r.err.trim() || "the file dialog failed" };
}

/** A path from the body (tests and smoke runs), else the dialog. */
async function pathFrom(b: Record<string, unknown> | null, choose: () => ReturnType<typeof chooseSavePath>) {
  if (typeof b?.path === "string" && b.path.startsWith("/")) return { path: b.path };
  return choose();
}

export function createMeRoutes(deps: { db: Db; dataDir: string; machine: () => string; sync: () => HomeSync | null }) {
  const { db } = deps;
  return async (req: Request, url: URL): Promise<Response | null> => {
    const p = url.pathname;
    const m = req.method;
    // On the Home Server (§6.1)
    if (p === "/api/me/state" && (m === "GET" || m === "HEAD")) {
      const since = url.searchParams.get("since");
      if (since && !isTime(since)) return json({ error: "since must be a time" }, 400);
      return json(stateSince(db, since));
    }
    if (p === "/api/me/resume" && m === "PUT") {
      const r = parseResume(await body(req));
      if (!r) return json({ error: "video (identity), resumeS (number or null) and resumeAt are required" }, 400);
      return json({ result: applyResume(db, new Resolver(db), r) });
    }
    if (p === "/api/me/favorite" && m === "PUT") {
      const f = parseFavorite(await body(req));
      if (!f) return json({ error: "video (identity), startMs (ms or null), favoritedAt (time or null) and favoriteAt are required" }, 400);
      return json({ result: applyFavorite(db, new Resolver(db), f) });
    }
    if (p === "/api/me/favorites" && m === "PUT") {
      // §6.2: first connect, the laptop's Favorites replace this machine's, which are written to the data dir first
      const b = await body(req);
      const list = Array.isArray(b?.favorites) ? (b!.favorites as Record<string, unknown>[]) : null;
      const favorites = list?.map((e) => ({ video: parseIdentity(e?.video), startMs: typeof e?.startMs === "number" ? e.startMs : null, favoritedAt: e?.favoritedAt }));
      if (!favorites || favorites.some((f) => !f.video || !isTime(f.favoritedAt))) return json({ error: "favorites: [{ video, startMs, favoritedAt }] is required" }, 400);
      const name = backupName(new Date(), (n) => existsSync(join(deps.dataDir, n)));
      writeFileSync(join(deps.dataDir, name), JSON.stringify(favoritesFile(db, deps.machine()), null, 2) + "\n");
      const r = replaceFavorites(db, { favorites: favorites as { video: NonNullable<(typeof favorites)[number]["video"]>; startMs: number | null; favoritedAt: string }[] });
      log(`Favorites replaced by another Mac's (${r.starred} starred, ${r.unstarred} unstarred, ${r.unknown} not here); the ones before are in ${name}`);
      return json({ ...r, backup: name });
    }
    // On a Mac (its own pages; the localhost guard already ran)
    if (p === "/api/home/sync" && m === "GET") return json(deps.sync()?.status() ?? null);
    if (p === "/api/home/first-sync" && m === "POST") {
      const sync = deps.sync();
      if (!sync) return json({ error: "No Home Server is set" }, 409);
      const where = await pathFrom(await body(req), chooseSavePath);
      if ("cancelled" in where) return json({ cancelled: true });
      if ("error" in where) return json({ error: where.error }, 500);
      const r = await sync.firstSync(where.path);
      return r.ok ? json({ ...r, path: where.path, sync: sync.status() }) : json({ error: r.error }, 502);
    }
    if (p === "/api/favorites/export" && m === "POST") {
      const where = await pathFrom(await body(req), chooseSavePath);
      if ("cancelled" in where) return json({ cancelled: true });
      if ("error" in where) return json({ error: where.error }, 500);
      const file = favoritesFile(db, deps.machine());
      try {
        writeFileSync(where.path, JSON.stringify(file, null, 2) + "\n");
      } catch (e) {
        return json({ error: `The file could not be saved: ${(e as Error).message}` }, 500);
      }
      return json({ path: where.path, count: file.favorites.length });
    }
    if (p === "/api/favorites/import" && m === "POST") {
      const where = await pathFrom(await body(req), chooseOpenPath);
      if ("cancelled" in where) return json({ cancelled: true });
      if ("error" in where) return json({ error: where.error }, 500);
      let file;
      try {
        file = parseFavoritesFile(JSON.parse(readFileSync(where.path, "utf8")));
      } catch {
        file = null;
      }
      if (!file) return json({ error: "That is not a TuvaVideos Favorites file" }, 422);
      const r = importFavorites(db, file);
      deps.sync()?.imported(r.applied);
      return json({ path: where.path, applied: r.applied.length, older: r.older, unknown: r.unknown });
    }
    return null;
  };
}
