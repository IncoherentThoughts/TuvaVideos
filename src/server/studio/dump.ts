// The Music.app library dump (spec 7.2): one bulk JXA read of {persistentID, name, album, artist, albumArtist, duration,
// cloudStatus} for every track, cached as JSON under the data dir, refreshed after each Mirror import and on any
// persistent-id miss. The read is one Apple event per property over the whole track list (columns), not one per track:
// ~3000 tracks in well under a second. Filter on `cloudStatus`, never on the localized `kind`.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { run } from "../proc";
import { log } from "../log";
import { BridgeRefused } from "./bridge";

export interface DumpTrack {
  persistentId: string;
  name: string;
  album: string;
  artist: string;
  albumArtist: string;
  /** Seconds; 0 when Music.app has none. */
  duration: number;
  /** Music.app's `cloud status`: subscription, uploaded, matched, purchased, removed, no longer available, unknown, ... */
  cloudStatus: string;
}

export interface DumpFile {
  takenAt: string;
  /** How long the read took. */
  ms: number;
  tracks: DumpTrack[];
}

export type DumpReader = () => Promise<DumpTrack[]>;

/** Statuses that Music.app cannot play at all; the matcher and the search leave them out. */
export const UNPLAYABLE_STATUS = new Set(["no longer available"]);
export const isPlayable = (t: DumpTrack) => !UNPLAYABLE_STATUS.has(t.cloudStatus);

export const DUMP_SCRIPT = `
const t = Application('Music').libraryPlaylists[0].tracks;
JSON.stringify({ id: t.persistentID(), name: t.name(), album: t.album(), artist: t.artist(), albumArtist: t.albumArtist(), duration: t.duration(), cloud: t.cloudStatus() });
`;

/** Rows out of the columns the script returns. Exported for the tests. */
export function dumpRows(cols: { id: string[]; name: string[]; album: string[]; artist: string[]; albumArtist: string[]; duration: (number | null)[]; cloud: string[] }): DumpTrack[] {
  const n = cols.id.length;
  const out: DumpTrack[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      persistentId: cols.id[i]!,
      name: cols.name[i] ?? "",
      album: cols.album[i] ?? "",
      artist: cols.artist[i] ?? "",
      albumArtist: cols.albumArtist[i] ?? "",
      duration: typeof cols.duration[i] === "number" ? cols.duration[i]! : 0,
      cloudStatus: String(cols.cloud[i] ?? "unknown"),
    });
  }
  return out;
}

/** The real reader: a one-off osascript (not the resident child, so a dump never blocks playback commands). */
export async function readDumpFromMusic(timeoutMs = 60_000): Promise<DumpTrack[]> {
  const r = await run("osascript", ["-l", "JavaScript", "-e", DUMP_SCRIPT], { timeout: timeoutMs });
  if (r.code !== 0) throw new BridgeRefused(`library dump failed: ${(r.err || `exit ${r.code}`).trim().slice(0, 200)}`);
  const cols = JSON.parse(r.out.trim());
  return dumpRows(cols);
}

/** A refresh within this long of the last one is reused: a burst of stale-id misses must not re-dump each time. */
const MIN_REFRESH_GAP_MS = 5_000;

export class DumpCache {
  private file: DumpFile | null = null;
  private mtime = 0;
  private inflight: Promise<DumpFile> | null = null;
  private lastRefreshAt = 0;
  private idIndex: Map<string, DumpTrack> | null = null;

  constructor(private path: string, private reader: DumpReader = readDumpFromMusic) {}

  /** The cached dump, re-read from disk when another process (the import CLI) has written it since. Null when none exists. */
  peek(): DumpFile | null {
    try {
      const m = statSync(this.path).mtimeMs;
      if (m !== this.mtime || !this.file) {
        this.file = JSON.parse(readFileSync(this.path, "utf8")) as DumpFile;
        this.mtime = m;
        this.idIndex = null;
      }
    } catch {
      if (!existsSync(this.path)) {
        this.file = null;
        this.idIndex = null;
      }
    }
    return this.file;
  }

  /** The cache, taking a dump first if there is none. Throws BridgeRefused when there is neither. */
  async get(): Promise<DumpFile> {
    return this.peek() ?? (await this.refresh());
  }

  /** Cache if present, else try a dump and settle for null (Music.app refused). */
  async getOrNull(): Promise<DumpFile | null> {
    try {
      return await this.get();
    } catch (e) {
      log("studio dump unavailable:", String((e as Error).message ?? e));
      return null;
    }
  }

  byId(id: string): DumpTrack | undefined {
    const f = this.peek();
    if (!f) return undefined;
    if (!this.idIndex) this.idIndex = new Map(f.tracks.map((t) => [t.persistentId, t]));
    return this.idIndex.get(id);
  }

  /** Reads Music.app again and rewrites the cache. Concurrent callers share one read. `force` skips the 5 s reuse window. */
  refresh(force = false): Promise<DumpFile> {
    if (this.inflight) return this.inflight;
    if (!force && this.file && Date.now() - this.lastRefreshAt < MIN_REFRESH_GAP_MS) return Promise.resolve(this.file);
    this.inflight = (async () => {
      const t0 = performance.now();
      try {
        const tracks = await this.reader();
        const f: DumpFile = { takenAt: new Date().toISOString(), ms: Math.round(performance.now() - t0), tracks };
        mkdirSync(dirname(this.path), { recursive: true });
        const tmp = `${this.path}.tmp`;
        writeFileSync(tmp, JSON.stringify(f));
        renameSync(tmp, this.path);
        this.file = f;
        this.mtime = statSync(this.path).mtimeMs;
        this.idIndex = null;
        this.lastRefreshAt = Date.now();
        log(`studio dump: ${tracks.length} tracks in ${f.ms} ms`);
        return f;
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}
