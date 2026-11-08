// The Download queue's HTTP routes (downloader-spec §6), minus `/tools`, `/plan`, `/settings` and `/choose-folder`, which
// other tickets own. One function so `api.ts` carries a single block; it answers null for paths that are not its own.

import { hostError, localRequestError } from "../localOnly";
import { QueueError, type DownloadQueue } from "./queue";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store", ...headers } });

const num = (s: string | null) => {
  const n = Number(s);
  return s !== null && s !== "" && Number.isFinite(n) ? n : null;
};

export async function downloadRoutes(req: Request, url: URL, q: DownloadQueue): Promise<Response | null> {
  const p = url.pathname;
  const m = req.method;
  let route: string | null = null;
  let id = 0;
  if (p === "/api/downloads" && m === "GET") route = "snapshot";
  else if (m === "POST" && (p === "/api/downloads/jobs" || p === "/api/downloads/card" || p === "/api/downloads/pause" || p === "/api/downloads/resume")) route = p.split("/").pop()!;
  else {
    const find = (re: RegExp, method: string, name: (g: RegExpMatchArray) => string) => {
      const g = m === method ? p.match(re) : null;
      if (g) (route = name(g)), (id = Number(g[1]));
    };
    find(/^\/api\/downloads\/jobs\/(\d+)\/(cancel|retry-failed|discard)$/, "POST", (g) => `job:${g[2]}`);
    find(/^\/api\/downloads\/items\/(\d+)\/(cancel|retry|dismiss)$/, "POST", (g) => `item:${g[2]}`);
    find(/^\/api\/downloads\/items\/(\d+)\/log$/, "GET", () => "item:log");
    find(/^\/api\/downloads\/jobs\/(\d+)\/report\.txt$/, "GET", () => "job:report");
  }
  if (!route) return null;

  // This machine's pages only (Host); a POST from a browser also needs a same-origin Origin, like the tools install.
  const refused = hostError(req) ?? (m === "POST" && req.headers.get("origin") ? localRequestError(req) : null);
  if (refused) return json({ error: refused }, 403);

  try {
    switch (route) {
      case "snapshot":
        return json(q.snapshot({ job: num(url.searchParams.get("job")), logCursor: num(url.searchParams.get("logCursor")) }));
      case "jobs": {
        const b = await body(req);
        return json(q.addBulk({ option: String(b.option ?? ""), quality: String(b.quality ?? ""), destDir: String(b.destDir ?? ""), videoIds: Array.isArray(b.videoIds) ? b.videoIds.map(String) : [], estBytes: b.estBytes as Record<string, number> | undefined }), 201);
      }
      case "card": {
        const b = await body(req);
        return json(q.addCard({ videoId: String(b.videoId ?? ""), quality: b.quality === undefined ? undefined : String(b.quality), destDir: b.destDir === undefined ? undefined : String(b.destDir) }), 201);
      }
      case "pause":
        await q.pause();
        return json({ paused: true });
      case "resume":
        q.resume();
        return json({ paused: false });
      case "job:cancel":
      case "job:discard":
        await q.cancelJob(id);
        return json({ cancelled: true });
      case "job:retry-failed":
        return json({ retried: q.retryFailed(id) });
      case "job:report": {
        const r = q.report(id);
        return new Response(r.text, { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename="${r.fileName}"`, "cache-control": "no-store" } });
      }
      case "item:cancel":
        await q.cancelItem(id);
        return json({ cancelled: true });
      case "item:retry":
        q.retryItem(id);
        return json({ retried: true });
      case "item:dismiss":
        q.dismissItem(id);
        return json({ dismissed: true });
      case "item:log":
        return json(q.itemLog(id, Math.min(2000, num(url.searchParams.get("tail")) ?? 200)));
    }
  } catch (e) {
    if (e instanceof QueueError) return json({ error: e.message, ...e.extra }, e.status);
    throw e;
  }
  return null;
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const b = await req.json();
    return b && typeof b === "object" && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
