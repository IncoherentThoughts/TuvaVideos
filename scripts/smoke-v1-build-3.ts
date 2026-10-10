// Smoke run for ticket #24 against a running server (the real library by default):
//   TUVA_PORT=4403 TUVA_NO_OPEN=1 TUVA_SCREENSHOT_DIR=/some/tmp/dir bun run start &   then   bun scripts/smoke-v1-build-3.ts [port]
// Touches one Video's Resume position (restored before exiting) and writes one screenshot into the server's
// screenshot folder. Never touches a Root.
const port = process.argv[2] ?? "4403";
const base = `http://localhost:${port}`;
const line = (...a: unknown[]) => console.log(...a);
const get = async (p: string, init?: RequestInit) => {
  const r = await fetch(base + p, init);
  return { r, text: await r.text() };
};
const json = async (p: string, init?: RequestInit) => JSON.parse((await get(p, init)).text);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const js = await get("/app.js");
line(`bundle: /app.js ${js.text.length} bytes (${Bun.gzipSync(Buffer.from(js.text)).length} gzip), /app.css ${(await get("/app.css")).text.length} bytes`);
for (const p of ["/play/1", "/play/1?t=30"]) line(`GET ${p} -> ${(await get(p)).r.status}`);

const vids: any[] = await json("/api/videos");
const avail = vids.filter((v) => v.available);
line(`${vids.length} Videos, ${avail.length} available`);
const two = avail.find((v) => v.copies.length > 1 && v.durationS > 120)!;
line(`Copy picker candidate: #${two.id} ${two.title.slice(0, 40)}: ${two.copies.map((c: any) => `${c.rootKind}/${c.container}/${c.height}p/${c.available ? "available" : "unavailable"}`).join(", ")}`);
line(`  Preferred Copy by the API: ${two.preferredCopyId} (first Available in ranking: ${two.copies.find((c: any) => c.available)?.id})`);

// Range seeks into the Preferred Copy: what a key seek costs the server (browser adds decode time on top)
const copy = two.copies.find((c: any) => c.id === two.preferredCopyId);
const full = await fetch(base + copy.url, { headers: { range: "bytes=0-0" } });
const total = Number(full.headers.get("content-range")!.split("/")[1]);
await full.arrayBuffer();
const lat: number[] = [];
for (let i = 0; i < 30; i++) {
  const start = Math.floor(Math.random() * (total - 600_000));
  const t0 = performance.now();
  const r = await fetch(base + copy.url, { headers: { range: `bytes=${start}-${start + 524_287}` } });
  await r.arrayBuffer();
  lat.push(performance.now() - t0);
}
line(`Range reads of 512 kB at random offsets in #${two.id}: median ${median(lat).toFixed(1)} ms, max ${Math.max(...lat).toFixed(1)} ms`);

// Resume: write, read back, finished rule, restore
const was = two.resumeS;
const post = (s: number) => json(`/api/videos/${two.id}/resume`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ resumeS: s, copyId: copy.id }) });
const w1 = await post(42.5);
const back = await json(`/api/videos/${two.id}`);
line(`resume 42.5 -> ${JSON.stringify(w1)}; API now says resumeS=${back.resumeS}, lastPlayedAt=${back.lastPlayedAt}`);
const w2 = await post(two.durationS - 10);
line(`resume ${(two.durationS - 10).toFixed(1)} (10 s before the end of ${two.durationS.toFixed(1)}) -> ${JSON.stringify(w2)}`);
const t0 = performance.now();
for (let i = 0; i < 20; i++) await post(10 + i);
line(`20 resume writes: ${((performance.now() - t0) / 20).toFixed(1)} ms each`);
await post(was ?? 0);
if (was == null) {
  line(`(Video #${two.id} had no Resume position; left at 0, which reopens at the start)`);
}

// Screenshot: any PNG body
const onePx = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
const shot = await json(`/api/videos/${two.id}/screenshot?t=12.5`, { method: "POST", headers: { "content-type": "image/png" }, body: onePx });
line(`screenshot -> ${JSON.stringify(shot)}`);
const bad = await fetch(`${base}/api/videos/${two.id}/screenshot?t=1`, { method: "POST", body: "not a png at all" });
line(`non-PNG screenshot body -> ${bad.status}`);
