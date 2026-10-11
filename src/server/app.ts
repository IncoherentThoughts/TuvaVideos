import { createHandler, type Services } from "./api";
import type { Config } from "./config";
import { checkpoint, openDb } from "./db";
import { FallbackQueue } from "./fallback";
import { initLog, log } from "./log";
import { Roots } from "./roots";
import { Studio, type StudioOptions } from "./studio/service";
import { Scanner } from "./scan";
import { rebuildSearchIndex } from "./search";
import { Thumbnails } from "./thumbs";
import { WebBundle } from "./web";

export interface App extends Services {
  server: ReturnType<typeof Bun.serve>;
  stop(): Promise<void>;
}

/**
 * Startup order (spec 9): migrations -> Root availability -> scan of mounted Roots (background) ->
 * Music.app playerState() read (launch.ts, via `app.studio.probe()`) -> caller opens the tab.
 */
export async function startApp(cfg: Config, opts: { studio?: StudioOptions; quit?: () => void } = {}): Promise<App> {
  initLog(cfg.logPath);
  log(`TuvaVideos starting, data dir ${cfg.dataDir}`);
  const db = openDb(cfg.dbPath, cfg.migrationsDir);

  const roots = new Roots(db, cfg);
  roots.seed();
  const fallback = new FallbackQueue(db, cfg, (id) => roots.isAvailable(id));
  await fallback.verifyFiles();
  const thumbs = new Thumbnails(db, cfg, roots, () => fallback.playJobRunning());
  const scanner = new Scanner(db, cfg, roots, () => {
    fallback.enqueueScanJobs();
    thumbs.adoptSeed();
    thumbs.kick(true);
  });
  roots.onBecameAvailable((r) => scanner.request(r.id)); // startup, remount

  const web = new WebBundle(cfg);
  await web.build();
  const idx = rebuildSearchIndex(db); // the index is also rebuilt after every scan
  log(`search index: ${idx.total} rows (${idx.video} video, ${idx.chapter} chapter, ${idx.artist} artist, ${idx.song} song, ${idx.lyric} lyric) in ${idx.ms} ms`);

  const studio = new Studio(db, cfg, opts.studio); // the osascript child starts on first use, never here
  const services: Services = { cfg, db, roots, scanner, fallback, thumbs, studio, web, startedAt: Date.now(), quit: opts.quit };
  const handler = createHandler(services);
  const server = Bun.serve({ port: cfg.port, hostname: "127.0.0.1", idleTimeout: 120, fetch: handler });
  log(`listening on http://localhost:${server.port}`);

  // Thumbnails already adopted from the seed cache are browsable before any Root answers.
  thumbs.adoptSeed();
  await roots.pollAll(); // fires the startup scans through onBecameAvailable
  roots.start(10_000);

  // The same object the handler reads (`quit` may be set later, e.g. by tests), not a copy.
  return Object.assign(services, {
    server,
    async stop() {
      log("shutting down: letting the in-flight ffmpeg job finish");
      roots.stop();
      studio.shutdown(); // kills the osascript child
      void server.stop();
      await Promise.all([fallback.shutdown(), thumbs.shutdown()]);
      checkpoint(db);
      db.close();
      log("bye");
    },
  });
}
