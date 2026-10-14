// PROTOTYPE — throwaway (issue #50). Serves the TV home prototype and proxies the running app (127.0.0.1:4400) for
// /api, /thumbs, /copy and the logo, with CORS so the packaged TV app can call it from file://. Listens on every
// interface so the TV reaches it; the app's own server stays on 127.0.0.1. Rebuilds main.js from app.ts on every
// page load, so a reload shows an edit.
//
//   bun run tv-prototype        → http://localhost:4412/?variant=A   (B, C; &bar=0 hides the switcher)
import { join } from "node:path";

const PORT = Number(process.env.PORT ?? 4412);
const UP = process.env.TUVA_URL ?? "http://127.0.0.1:4400";
const HERE = import.meta.dir;
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "range, content-type", "access-control-expose-headers": "content-range, content-length, accept-ranges" };

export async function build(): Promise<boolean> {
  const r = await Bun.build({ entrypoints: [join(HERE, "app.ts")], outdir: HERE, naming: "main.[ext]", target: "browser", sourcemap: "inline" });
  if (!r.success) for (const l of r.logs) console.error(String(l));
  return r.success;
}

if (import.meta.main) {
  await build();
  const STATIC: Record<string, string> = { "/main.js": "text/javascript", "/styles.css": "text/css", "/icon.png": "image/png" };
  Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (p === "/" || p === "/index.html") {
        const ok = await build();
        return ok ? new Response(Bun.file(join(HERE, "index.html")), { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("build failed, see the terminal", { status: 500 });
      }
      if (STATIC[p]) return new Response(Bun.file(join(HERE, p)), { headers: { "content-type": STATIC[p]!, ...CORS } });
      if (/^\/(api|thumbs|copy)\//.test(p) || p === "/olchey.svg") {
        const headers: Record<string, string> = {};
        for (const h of ["range", "accept", "content-type"]) { const v = req.headers.get(h); if (v) headers[h] = v; }
        const r = await fetch(UP + p + url.search, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body, redirect: "manual" });
        const out = new Headers(r.headers);
        for (const [k, v] of Object.entries(CORS)) out.set(k, v);
        return new Response(r.body, { status: r.status, headers: out });
      }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`TV home prototype: http://localhost:${PORT}/?variant=A  (B, C) · proxying ${UP} · TV reaches this host on port ${PORT}`);
}
