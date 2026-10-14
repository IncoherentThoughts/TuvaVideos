// Throwaway LAN server for the hello-world TV install (#48). Not part of the app: the app's server stays on
// 127.0.0.1. Serves a fixed set of test Copies with Range support, logs every request's headers, and appends the
// TV's playback reports to results.jsonl.
//
//   bun tv/hello-world/serve.ts            # listens on 0.0.0.0:4410
import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseRange } from "../../src/server/range";

const PORT = Number(process.env.PORT ?? 4410);
const HERE = import.meta.dir;
const DB = join(homedir(), "Library", "Application Support", "TuvaVideos", "library.db");

// One Copy per codec combination worth settling on the TV (docs/research/tizen-2026-r85h.md §7).
const TESTS: { id: number; label: string }[] = [
  { id: 1118, label: "mp4 h264 aac 1080p (control)" },
  { id: 425, label: "webm vp9 opus 1080p" },
  { id: 2251, label: "mkv vp9 opus 1080p" },
  { id: 1316, label: "webm vp9 opus 4K" },
  { id: 1363, label: "mkv av1 opus 4K" },
  { id: 805, label: "webm av1 opus 4K-ish" },
  { id: 0, label: "mkv h264 opus (most common)" },
  { id: 0, label: "mp4 vp9 aac" },
];

const db = new Database(DB, { readonly: true });
type Row = { id: number; path: string; container: string; video_codec: string; audio_codec: string; width: number; height: number; size: number; duration_s: number };
const byId = db.query<Row, [number]>(
  `SELECT c.id, r.path || '/' || c.rel_path AS path, c.container, c.video_codec, c.audio_codec, c.width, c.height, c.size, c.duration_s
   FROM copy c JOIN root r ON r.id = c.root_id WHERE c.id = ?`,
);
const firstOf = db.query<{ id: number }, [string, string, string]>(
  `SELECT id FROM copy WHERE missing_since IS NULL AND container = ? AND video_codec = ? AND audio_codec = ? AND height = 1080 ORDER BY size LIMIT 1`,
);
TESTS[6]!.id = firstOf.get("mkv", "h264", "opus")?.id ?? 0;
TESTS[7]!.id = firstOf.get("mp4", "vp9", "aac")?.id ?? 0;
const copies = TESTS.filter((t) => t.id).map((t) => ({ ...t, ...byId.get(t.id)! }));

const MIME: Record<string, string> = { mp4: "video/mp4", webm: "video/webm", mkv: "video/x-matroska" };
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type" };

function logLine(o: object) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...o });
  console.log(line);
  appendFileSync(join(HERE, "requests.log"), line + "\n");
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  idleTimeout: 120,
  async fetch(req, srv) {
    const url = new URL(req.url);
    logLine({ ip: srv.requestIP(req)?.address, method: req.method, path: url.pathname, headers: Object.fromEntries(req.headers) });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    // The packaged app's files, for a desktop-browser smoke run before installing.
    const app = url.pathname.match(/^\/app\/(index\.html|main\.js|icon\.png)$/);
    if (app) return new Response(Bun.file(join(HERE, app[1]!)));

    if (url.pathname === "/tests.json")
      return Response.json(copies.map(({ path, ...c }) => c), { headers: cors });

    if (url.pathname === "/report" && req.method === "POST") {
      appendFileSync(join(HERE, "results.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...(await req.json()) }) + "\n");
      return new Response("ok", { headers: cors });
    }

    const m = url.pathname.match(/^\/copy\/(\d+)$/);
    const c = m && copies.find((x) => x.id === Number(m[1]));
    if (!c) return new Response("not found", { status: 404, headers: cors });
    const file = Bun.file(c.path);
    const size = file.size;
    const type = MIME[c.container] ?? "application/octet-stream";
    const r = parseRange(req.headers.get("range"), size);
    if (r.kind === "unsatisfiable")
      return new Response(null, { status: 416, headers: { ...cors, "Content-Range": `bytes */${size}` } });
    if (r.kind === "range")
      return new Response(file.slice(r.start, r.end + 1), {
        status: 206,
        headers: { ...cors, "Content-Type": type, "Accept-Ranges": "bytes", "Content-Range": `bytes ${r.start}-${r.end}/${size}`, "Content-Length": String(r.end - r.start + 1) },
      });
    return new Response(file, { headers: { ...cors, "Content-Type": type, "Accept-Ranges": "bytes", "Content-Length": String(size) } });
  },
});

console.log(`hello-world TV server on http://0.0.0.0:${server.port}`);
for (const c of copies) console.log(`  ${c.id}\t${c.label}\t${c.width}x${c.height}\t${(c.size / 1e6).toFixed(0)} MB`);
