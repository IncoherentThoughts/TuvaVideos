// Smoke run for ticket #23 against a running server (the real library by default):
//   TUVA_PORT=4402 bun run start &   then   bun scripts/smoke-v1-build-2.ts [port]
// Read-only except for one Favorite toggle that it undoes before exiting.
const port = process.argv[2] ?? "4402";
const base = `http://localhost:${port}`;

async function timed<T>(label: string, url: string, init?: RequestInit): Promise<{ body: T; ms: number; bytes: number }> {
  const t0 = performance.now();
  const r = await fetch(base + url, init);
  const text = await r.text();
  const ms = performance.now() - t0;
  if (!r.ok) throw new Error(`${label}: ${r.status} ${text.slice(0, 200)}`);
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {}
  return { body, ms, bytes: text.length };
}

const line = (...a: unknown[]) => console.log(...a);
const js = await timed<string>("bundle", "/app.js");
const css = await timed<string>("css", "/app.css");
line(`bundle: /app.js ${js.bytes} bytes (${Bun.gzipSync(Buffer.from(js.body as string)).length} gzip), /app.css ${css.bytes} bytes`);
for (const p of ["/", "/favorites", "/artists", "/play/1?t=30"]) {
  const r = await fetch(base + p);
  line(`GET ${p} -> ${r.status} ${r.headers.get("content-type")}`);
}
const vids = await timed<any[]>("videos", "/api/videos");
line(`/api/videos: ${vids.body.length} Videos, ${vids.bytes} bytes, ${vids.ms.toFixed(0)} ms; available ${vids.body.filter((v) => v.available).length}; with Thumbnail ${vids.body.filter((v) => v.thumbnail).length}`);
const health = (await timed<any>("health", "/api/health")).body;
line(`roots: ${health.roots.map((r: any) => `${r.kind}=${r.available ? "up" : "down"}`).join(", ")}`);
const artists = await timed<any[]>("artists", "/api/artists");
line(`/api/artists: ${artists.body.length} Artists with a Video`);

async function search(q: string) {
  const runs: number[] = [];
  let last: any;
  for (let i = 0; i < 10; i++) {
    const r = await timed<any>("search", `/api/search?q=${encodeURIComponent(q)}`);
    runs.push(r.ms);
    last = r.body;
  }
  runs.sort((a, b) => a - b);
  const groups = last.groups.map((g: any) => `${g.key}:${g.total}`).join(" ") || "(no groups)";
  const first = last.groups[0]?.rows[0];
  const name = first ? (first.title ?? first.name ?? `${first.videoTitle} > ${first.title}`) : "-";
  line(`search ${JSON.stringify(q)}: ${groups}; first: ${name}; client round trip median ${runs[5]!.toFixed(1)} ms, server ${last.ms} ms`);
  return last;
}
const first = (vids.body.find((v) => v.available) ?? vids.body[0])!;
const cyr = vids.body.map((v) => v.title as string).find((t) => /[Ѐ-ӿ]{4}/.test(t));
const lat = vids.body.map((v) => v.title as string).find((t) => /^[A-Za-z]{5}/.test(t));
await search("#available");
await search("#videos");
await search("#fav");
await search("#type:concert");
if (cyr) await search(cyr.match(/[Ѐ-ӿ]{4,}/)![0]!);
if (lat) await search(lat.slice(0, 6));
await search("khoomei");
await search("xoomei");
await search("tyva");
await search("zzzzqq");

// Favorite round trip
const before = first.favoritedAt;
const on = await timed<any>("fav", `/api/videos/${first.id}/favorite`, { method: "POST", body: JSON.stringify({ favorite: true }) });
const favs = (await timed<any[]>("favorites", "/api/favorites")).body;
const listed = favs.find((f) => f.kind === "video" && f.video.id === first.id);
line(`favorite: set Video ${first.id} (${JSON.stringify(first.title)}) -> ${on.body.favorite}; in /api/favorites: ${!!listed}, position ${favs.indexOf(listed)} of ${favs.length}`);
if (!before) await timed<any>("unfav", `/api/videos/${first.id}/favorite`, { method: "POST", body: JSON.stringify({ favorite: false }) });
line(`favorite restored to ${before ? "starred" : "not starred"}`);
