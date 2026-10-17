import { createHandler, type Services } from "./api";
import { TvServer } from "./tv";
import { judgeStaleCopies } from "./tvJudge";
import type { Config } from "./config";
import { checkpoint, openDb } from "./db";
import { FallbackQueue } from "./fallback";
import { KeyframeIndex } from "./keyframes";
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
 * Startup order (spec 9): migrations -> Root availability -> Music.app playerState() read (launch.ts, via
 * `app.studio.probe()`) -> caller opens the tab. No scan and no Thumbnail pass at startup (they cost ffmpeg CPU while
 * the first Video plays): the Rescan button starts them, and a Root mounted later is scanned when it appears.
 */
export async function startApp(cfg: Config, opts: { studio?: StudioOptions; quit?: () => void } = {}): Promise<App> {
  initLog(cfg.logPath);
  log(`TuvaVideos starting, data dir ${cfg.dataDir}${cfg.passive ? " (passive: no remount scan)" : ""}`);
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
  const keyframes = new KeyframeIndex(db, cfg, (id) => roots.isAvailable(id));
  // remount only: the Roots found at startup are not scanned (spec 3.2, 9); a passive server (a test preview on
  // the real library) scans only on an explicit Rescan
  let started = false;
  roots.onBecameAvailable((r) => {
    if (started && !cfg.passive) scanner.request(r.id);
  });

  // The TV Playback profile result per Copy, from the stored ffprobe facts (no re-probe): fills the column after its
  // migration and re-judges rows made under an older profile version (tv-spec 3.1).
  const judged = judgeStaleCopies(db);
  if (judged) log(`TV profile: judged ${judged} Copies`);

  const web = new WebBundle(cfg);
  await web.build();
  const idx = rebuildSearchIndex(db); // the index is also rebuilt after every scan
  log(`search index: ${idx.total} rows (${idx.video} video, ${idx.chapter} chapter, ${idx.artist} artist, ${idx.song} song, ${idx.lyric} lyric) in ${idx.ms} ms`);

  const studio = new Studio(db, cfg, opts.studio); // the osascript child starts on first use, never here
  const tv = new TvServer({ cfg, db }); // off at every launch: only POST /api/tv/on binds the port
  const services: Services = { cfg, db, roots, scanner, fallback, thumbs, keyframes, studio, web, tv, startedAt: Date.now(), quit: opts.quit };
  const handler = createHandler(services);
  tv.setHandler(handler);
  const server = Bun.serve({ port: cfg.port, hostname: "127.0.0.1", idleTimeout: 120, fetch: handler });
  log(`listening on http://localhost:${server.port}`);

  // Thumbnails already adopted from the seed cache are browsable before any Root answers.
  thumbs.adoptSeed();
  await roots.pollAll(); // availability only: nothing is scanned at startup
  started = true;
  roots.start(10_000);

  // The same object the handler reads (`quit` may be set later, e.g. by tests), not a copy.
  return Object.assign(services, {
    server,
    async stop() {
      log("shutting down: letting the in-flight ffmpeg job finish");
      roots.stop();
      tv.stop();
      studio.shutdown(); // kills the osascript child
      void server.stop();
      keyframes.shutdown();
      await Promise.all([fallback.shutdown(), thumbs.shutdown()]);
      checkpoint(db);
      db.close();
      log("bye");
    },
  });
}
