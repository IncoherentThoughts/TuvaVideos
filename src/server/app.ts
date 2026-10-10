import { createHandler, type Services } from "./api";
import type { Config } from "./config";
import { checkpoint, openDb } from "./db";
import { FallbackQueue } from "./fallback";
import { initLog, log } from "./log";
import { Roots } from "./roots";
import { Scanner } from "./scan";
import { Thumbnails } from "./thumbs";

export interface App extends Services {
  server: ReturnType<typeof Bun.serve>;
  stop(): Promise<void>;
}

/**
 * Startup order (spec 9): migrations -> Root availability -> scan of mounted Roots (background) ->
 * [Music.app playerState() read: ticket #27, skipped] -> caller opens the tab.
 */
export async function startApp(cfg: Config): Promise<App> {
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

  const services: Services = { cfg, db, roots, scanner, fallback, thumbs, startedAt: Date.now() };
  const handler = createHandler(services);
  const server = Bun.serve({ port: cfg.port, hostname: "127.0.0.1", idleTimeout: 120, fetch: handler });
  log(`listening on http://localhost:${server.port}`);

  // Thumbnails already adopted from the seed cache are browsable before any Root answers.
  thumbs.adoptSeed();
  await roots.pollAll(); // fires the startup scans through onBecameAvailable
  roots.start(10_000);

  return {
    ...services,
    server,
    async stop() {
      log("shutting down: letting the in-flight ffmpeg job finish");
      roots.stop();
      void server.stop();
      await Promise.all([fallback.shutdown(), thumbs.shutdown()]);
      checkpoint(db);
      db.close();
      log("bye");
    },
  };
}
