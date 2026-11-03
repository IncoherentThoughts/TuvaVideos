import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config";
import { log } from "./log";

/**
 * The UI bundle (spec 9, "UI stack"): Preact + TypeScript bundled by Bun at startup, held in memory and served as
 * `/app.js`; `/app.css` is the stylesheet file as it is. `bun run start` therefore always serves the current UI.
 */
export class WebBundle {
  private js = "";
  private error: string | null = null;
  bytes = 0;
  buildMs = 0;

  constructor(private cfg: Pick<Config, "webDir">) {}

  async build(): Promise<void> {
    const t0 = performance.now();
    try {
      const res = await Bun.build({
        entrypoints: [join(this.cfg.webDir, "main.tsx")],
        target: "browser",
        minify: true,
        sourcemap: "none",
        define: { "process.env.NODE_ENV": '"production"' },
      });
      if (!res.success) throw new Error(res.logs.map((l) => String(l)).join("\n"));
      this.js = await res.outputs[0]!.text();
      this.bytes = this.js.length;
      this.error = null;
    } catch (e) {
      this.error = String((e as Error).message ?? e);
      this.js = `document.body.innerHTML = '<pre style="color:#fb4934;padding:20px">UI build failed:\\n' + ${JSON.stringify(this.error)} + '</pre>';`;
      log(`web bundle failed: ${this.error}`);
    }
    this.buildMs = Math.round(performance.now() - t0);
    if (!this.error) log(`web bundle built: ${this.bytes} bytes in ${this.buildMs} ms`);
  }

  serve(path: "/app.js" | "/app.css"): Response {
    const noStore = { "cache-control": "no-store" };
    if (path === "/app.js") return new Response(this.js, { headers: { "content-type": "text/javascript; charset=utf-8", ...noStore } });
    return new Response(Bun.file(join(this.cfg.webDir, "styles.css")), { headers: { "content-type": "text/css; charset=utf-8", ...noStore } });
  }
}

/**
 * The TV UI bundle (docs/tv-spec.md 4.1): `src/tv/main.tsx` bundled next to the browser one, served by the TV Server as
 * `/tv.js`, with `src/tv/styles.css` as `/tv.css`. Built at start; a failed build serves a message instead of the UI.
 */
export class TvBundle {
  private js = "";
  private error: string | null = null;
  bytes = 0;
  buildMs = 0;

  constructor(private cfg: Pick<Config, "webDir">) {}

  /** `src/tv`, next to `src/web`. */
  get dir(): string {
    return join(this.cfg.webDir, "..", "tv");
  }

  async build(): Promise<void> {
    const t0 = performance.now();
    try {
      const res = await Bun.build({
        entrypoints: [join(this.dir, "main.tsx")],
        target: "browser",
        minify: true,
        sourcemap: "none",
        define: { "process.env.NODE_ENV": '"production"' },
      });
      if (!res.success) throw new Error(res.logs.map((l) => String(l)).join("\n"));
      this.js = await res.outputs[0]!.text();
      this.bytes = this.js.length;
      this.error = null;
    } catch (e) {
      this.error = String((e as Error).message ?? e);
      this.js = `document.body.innerHTML = '<pre style="color:#fb4934;padding:20px;font-size:20px">TV UI build failed:\\n' + ${JSON.stringify(this.error)} + '</pre>';`;
      log(`tv bundle failed: ${this.error}`);
    }
    this.buildMs = Math.round(performance.now() - t0);
    if (!this.error) log(`tv bundle built: ${this.bytes} bytes in ${this.buildMs} ms`);
  }

  serve(path: "/tv.js" | "/tv.css"): Response {
    const noStore = { "cache-control": "no-store" };
    if (path === "/tv.js") return new Response(this.js, { headers: { "content-type": "text/javascript; charset=utf-8", ...noStore } });
    // fonts.css first: its @font-face rules load /fonts/* relative to /tv.css.
    const css = ["fonts.css", "styles.css"].map((f) => readFileSync(join(this.dir, f), "utf8")).join("\n");
    return new Response(css, { headers: { "content-type": "text/css; charset=utf-8", ...noStore } });
  }
}
