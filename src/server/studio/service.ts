// Studio playback on the server (spec 7): Studio tracks of a Song, the miss-UI writes, and the one Music.app session.
// The Bridge and the DumpCache are injected so the tests never touch Music.app.
import type { Config } from "../config";
import type { Db } from "../db";
import { log } from "../log";
import { foldQuery } from "../../shared/fold";
import type { DumpHitDto, MissingTrackDto, SongStudioDto, StudioEnd, StudioEntryDto, StudioStateDto } from "../../shared/studio";
import { clampStudioSeek } from "../../shared/studio";
import { BridgeRefused, ResidentBridge, probeAutomation, REFUSED_MESSAGE, type Bridge, type PlayerState } from "./bridge";
import { DumpCache, isPlayable, type DumpFile, type DumpTrack } from "./dump";
import { buildIndex, deleteStudioRow, loadMirrorTracks, matchTrack, rematchTrack, type MatchIndex, type StudioRow } from "./match";

type Result<T> = { ok: true; value: T } | { ok: false; status: number; error: string; refused?: boolean };
const bad = (error: string, status = 400): { ok: false; status: number; error: string } => ({ ok: false, status, error });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export interface StudioOptions {
  bridge?: Bridge;
  dump?: DumpCache;
  /** Poll period while playing and while an A-B loop is active (spec 7.1: 1 Hz, 4 Hz). */
  pollMs?: number;
  loopPollMs?: number;
  /** After a play, a different or missing track in the poll is ignored this long (the player may not have caught up). */
  graceMs?: number;
  /** false: no timer; the tests call `tick()`. */
  autoPoll?: boolean;
}

const hit = (t: DumpTrack): DumpHitDto => ({ persistentId: t.persistentId, name: t.name, album: t.album, artist: t.artist, albumArtist: t.albumArtist, durationS: t.duration, cloudStatus: t.cloudStatus });

interface Session {
  studioTrackId: number;
  songId: string;
  persistentId: string;
  name: string;
  album: string;
  startedAt: number;
}

export class Studio {
  readonly bridge: Bridge;
  readonly dump: DumpCache;
  private pollMs: number;
  private loopPollMs: number;
  private graceMs: number;
  private autoPoll: boolean;
  private session: Session | null = null;
  private last: PlayerState | null = null;
  private lastAt = 0;
  private ended: StudioEnd | null = null;
  private refusedMsg: string | null = null;
  private loop = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = 0;
  private indexCache = new WeakMap<DumpFile, MatchIndex>();

  constructor(private db: Db, cfg: Config, opts: StudioOptions = {}) {
    this.bridge = opts.bridge ?? new ResidentBridge();
    this.dump = opts.dump ?? new DumpCache(cfg.studioDumpPath);
    this.pollMs = opts.pollMs ?? 1000;
    this.loopPollMs = opts.loopPollMs ?? 250;
    this.graceMs = opts.graceMs ?? 2500;
    this.autoPoll = opts.autoPoll ?? true;
  }

  // ---- launch ----

  /** Spec 9: the one `playerState()` read at launch, so the Automation prompt appears now. Never blocks or throws. */
  async probe(): Promise<void> {
    const r = await probeAutomation();
    if (r.ok) log(`Music.app: playerState() = ${r.state} (${r.ms} ms)`);
    else log(`Music.app: playerState() failed (${r.ms} ms): ${r.error}. Studio playback needs Automation consent for Music (System Settings › Privacy & Security › Automation).`);
  }

  shutdown() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.bridge.close();
  }

  // ---- reads ----

  private indexFor(file: DumpFile): MatchIndex {
    let i = this.indexCache.get(file);
    if (!i) this.indexCache.set(file, (i = buildIndex(file.tracks)));
    return i;
  }

  private rows(songId: string): StudioRow[] {
    return this.db.query("SELECT * FROM studio_track WHERE song_id = ?").all(songId) as StudioRow[];
  }

  /** The Song's Tracks and Studio tracks (spec 7.3). A Song with neither is `{tracks: [], missing: []}`: the UI says "no studio tracks". */
  async songStudio(songId: string): Promise<SongStudioDto> {
    const file = await this.dump.getOrNull();
    const idx = file ? this.indexFor(file) : null;
    const mts = loadMirrorTracks(this.db).filter((t) => t.songId === songId);
    const mtById = new Map(mts.map((t) => [t.id, t]));
    const rows = this.rows(songId);
    const tracks: StudioEntryDto[] = rows.map((r) => {
      const d = file ? this.dump.byId(r.persistent_id) : undefined;
      const mt = r.mirror_track_id ? mtById.get(r.mirror_track_id) : undefined;
      return {
        id: r.id,
        mirrorTrackId: r.mirror_track_id,
        kind: r.mirror_track_id ? "mirror" : "local",
        // without any dump we cannot say the id is gone: only a dump that lacks it makes the track "missing"
        state: file && !d ? "missing" : r.suggested ? "suggested" : "confirmed",
        persistentId: r.persistent_id,
        name: d?.name ?? mt?.name ?? "(not in Music.app)",
        album: d?.album ?? mt?.album ?? "",
        artist: d?.artist ?? "",
        durationS: d ? d.duration || null : mt?.durationS ?? null,
        cloudStatus: d?.cloudStatus ?? null,
        trackNumber: mt?.trackNumber ?? null,
      };
    });
    const addedAt = new Map(rows.map((r) => [r.id, r.added_at]));
    tracks.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "mirror" ? -1 : 1;
      if (a.kind === "local") return (addedAt.get(a.id)! < addedAt.get(b.id)! ? -1 : addedAt.get(a.id)! > addedAt.get(b.id)! ? 1 : a.id - b.id);
      return a.album.localeCompare(b.album) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0) || a.id - b.id;
    });
    const matched = new Set(rows.map((r) => r.mirror_track_id));
    const missing: MissingTrackDto[] = mts
      .filter((t) => !matched.has(t.id))
      .sort((a, b) => a.album.localeCompare(b.album) || a.trackNumber - b.trackNumber)
      .map((t) => {
        const r = idx ? matchTrack(t, idx) : null;
        // a rejected or cleared "match" is still a candidate: show it as an offer too
        const offers = r?.kind === "offer" ? r.candidates : r?.kind === "match" ? [r.track] : [];
        return { mirrorTrackId: t.id, name: t.name, album: t.album, trackNumber: t.trackNumber, durationS: t.durationS, offers: offers.map(hit) };
      });
    const lastRow = this.db.query("SELECT studio_track_id FROM studio_last WHERE song_id = ?").get(songId) as { studio_track_id: number } | null;
    const lastId = lastRow && tracks.some((t) => t.id === lastRow.studio_track_id) ? lastRow.studio_track_id : null;
    return { songId, tracks, missing, lastId, dumpAt: file?.takenAt ?? null };
  }

  /** Search over the dump (spec 7.3 miss UI): folded tokens against name, album and artist; name hits first. */
  async search(q: string, limit = 40): Promise<DumpHitDto[]> {
    const file = await this.dump.getOrNull();
    const needle = foldQuery(q);
    if (!file || !needle) return [];
    const toks = needle.split(" ");
    const scored: { t: DumpTrack; s: number }[] = [];
    for (const t of file.tracks) {
      if (!isPlayable(t)) continue;
      const name = foldQuery(t.name);
      const hay = `${name} ${foldQuery(t.album)} ${foldQuery(t.artist)} ${foldQuery(t.albumArtist)}`;
      if (!toks.every((k) => hay.includes(k))) continue;
      scored.push({ t, s: name === needle ? 0 : name.startsWith(needle) ? 1 : toks.every((k) => name.includes(k)) ? 2 : 3 });
    }
    scored.sort((a, b) => a.s - b.s || a.t.name.localeCompare(b.t.name) || a.t.album.localeCompare(b.t.album));
    return scored.slice(0, limit).map((x) => hit(x.t));
  }

  // ---- writes (the miss UI) ----

  /** "match this Track": a confirmed match for one Mirror Track. Replaces whatever was there. */
  async matchMirrorTrack(mirrorTrackId: string, persistentId: string): Promise<Result<{ id: number }>> {
    const mt = this.db.query("SELECT id, song_id FROM archive_track WHERE id = ?").get(mirrorTrackId) as { id: string; song_id: string | null } | null;
    if (!mt) return bad("no such Mirror Track", 404);
    if (!mt.song_id) return bad("this Track has no Song, so it has no Studio tracks", 409);
    if (!(await this.knows(persistentId))) return bad("that track is not in the Music.app library", 404);
    const now = new Date().toISOString();
    const id = this.tx(() => {
      const old = this.db.query("SELECT * FROM studio_track WHERE mirror_track_id = ?").get(mirrorTrackId) as StudioRow | null;
      const local = this.db.query("SELECT * FROM studio_track WHERE song_id = ? AND mirror_track_id IS NULL AND persistent_id = ?").get(mt.song_id, persistentId) as StudioRow | null;
      this.db.query("DELETE FROM studio_rejection WHERE mirror_track_id = ? AND persistent_id = ?").run(mirrorTrackId, persistentId);
      if (local) {
        if (old) deleteStudioRow(this.db, old.id, local.id);
        this.db.query("UPDATE studio_track SET mirror_track_id = ?, suggested = 0 WHERE id = ?").run(mirrorTrackId, local.id);
        return local.id;
      }
      if (old) {
        this.db.query("UPDATE studio_track SET persistent_id = ?, suggested = 0, song_id = ? WHERE id = ?").run(persistentId, mt.song_id, old.id);
        return old.id;
      }
      return Number(this.db.query("INSERT INTO studio_track (song_id, mirror_track_id, persistent_id, suggested, added_at) VALUES (?, ?, ?, 0, ?)").run(mt.song_id, mirrorTrackId, persistentId, now).lastInsertRowid);
    });
    return ok({ id });
  }

  /** "add to Song": a Local Studio track. A Song that already lists this recording is told so, not duplicated. */
  async addLocal(songId: string, persistentId: string): Promise<Result<{ id: number }>> {
    if (!this.db.query("SELECT 1 FROM song_all WHERE id = ?").get(songId)) return bad("no such Song", 404);
    if (!(await this.knows(persistentId))) return bad("that track is not in the Music.app library", 404);
    const dup = this.db.query("SELECT id FROM studio_track WHERE song_id = ? AND persistent_id = ?").get(songId, persistentId) as { id: number } | null;
    if (dup) return bad("the Song already lists that track", 409);
    const r = this.db.query("INSERT INTO studio_track (song_id, mirror_track_id, persistent_id, suggested, added_at) VALUES (?, NULL, ?, 0, ?)").run(songId, persistentId, new Date().toISOString());
    return ok({ id: Number(r.lastInsertRowid) });
  }

  confirm(id: number): Result<{ id: number }> {
    const r = this.db.query("UPDATE studio_track SET suggested = 0 WHERE id = ?").run(id);
    return r.changes ? ok({ id }) : bad("no such Studio track", 404);
  }

  /** Reject a Suggested match or remove a confirmed or Local one. A removed Mirror match is tombstoned so the matcher does not bring it back. */
  remove(id: number): Result<{ removed: true; tombstoned: boolean }> {
    const row = this.db.query("SELECT * FROM studio_track WHERE id = ?").get(id) as StudioRow | null;
    if (!row) return bad("no such Studio track", 404);
    let tombstoned = false;
    this.tx(() => {
      if (row.mirror_track_id) {
        this.db.query("INSERT OR IGNORE INTO studio_rejection (mirror_track_id, persistent_id) VALUES (?, ?)").run(row.mirror_track_id, row.persistent_id);
        tombstoned = true;
      }
      deleteStudioRow(this.db, id);
    });
    if (this.session?.studioTrackId === id) void this.stop();
    return ok({ removed: true, tombstoned });
  }

  private tx<T>(f: () => T): T {
    this.db.exec("BEGIN");
    try {
      const v = f();
      this.db.exec("COMMIT");
      return v;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Is the id in the library? A miss re-reads Music.app once (the dump may predate the track). */
  private async knows(persistentId: string): Promise<boolean> {
    await this.dump.getOrNull();
    if (this.dump.byId(persistentId)) return true;
    try {
      await this.dump.refresh();
    } catch {
      return false;
    }
    return !!this.dump.byId(persistentId);
  }

  // ---- playback ----

  state(): StudioStateDto {
    const s = this.session;
    const l = this.last;
    return {
      active: !!s,
      studioTrackId: s?.studioTrackId ?? null,
      songId: s?.songId ?? null,
      persistentId: s?.persistentId ?? null,
      name: s?.name ?? null,
      album: s?.album ?? null,
      state: s && l ? l.state : null,
      position: s && l ? l.position : null,
      duration: s && l ? l.duration : null,
      ended: s ? null : this.ended,
      refused: this.refusedMsg,
      at: this.lastAt,
    };
  }

  private fail(e: unknown): Result<never> {
    if (e instanceof BridgeRefused) {
      log("music bridge refused:", e.detail);
      this.end("refused", REFUSED_MESSAGE);
      return { ok: false, status: 502, error: REFUSED_MESSAGE, refused: true };
    }
    throw e;
  }

  private end(why: StudioEnd, refused: string | null = null) {
    this.session = null;
    this.ended = why;
    this.refusedMsg = refused;
    this.loop = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private rowFor(id: number): StudioRow | null {
    return this.db.query("SELECT * FROM studio_track WHERE id = ?").get(id) as StudioRow | null;
  }

  async play(studioTrackId: number): Promise<Result<StudioStateDto>> {
    let row = this.rowFor(studioTrackId);
    if (!row) return bad("no such Studio track", 404);
    this.busy++;
    try {
      let r = await this.bridge.play(row.persistent_id);
      if (!r.found) {
        // Stale persistent id (library rebuilt, spec 7.3): re-dump, re-match that Track, try the new id once.
        log(`studio: persistent id ${row.persistent_id} not in Music.app; re-dumping`);
        const file = await this.dump.refresh(true);
        if (row.mirror_track_id) rematchTrack(this.db, file.tracks, row.mirror_track_id);
        const again = this.rowFor(studioTrackId) ?? (row.mirror_track_id ? ((this.db.query("SELECT * FROM studio_track WHERE mirror_track_id = ?").get(row.mirror_track_id) as StudioRow | null) ?? null) : null);
        if (!again || again.persistent_id === row.persistent_id) return { ok: false, status: 404, error: "that track is no longer in the Music.app library" };
        row = again;
        r = await this.bridge.play(row.persistent_id);
        if (!r.found) return { ok: false, status: 404, error: "that track is no longer in the Music.app library" };
      }
      const d = this.dump.byId(row.persistent_id);
      this.session = { studioTrackId: row.id, songId: row.song_id, persistentId: row.persistent_id, name: d?.name ?? "", album: d?.album ?? "", startedAt: Date.now() };
      this.ended = null;
      this.refusedMsg = null;
      this.record(r);
      this.db.query("INSERT INTO studio_last (song_id, studio_track_id) VALUES (?, ?) ON CONFLICT(song_id) DO UPDATE SET studio_track_id = excluded.studio_track_id").run(row.song_id, row.id);
      this.schedule();
      return ok(this.state());
    } catch (e) {
      return this.fail(e);
    } finally {
      this.busy--;
    }
  }

  private record(s: PlayerState) {
    this.last = s;
    this.lastAt = Date.now();
  }

  private async cmd(f: () => Promise<PlayerState>): Promise<Result<StudioStateDto>> {
    if (!this.session) return bad("Studio playback is not active", 409);
    this.busy++;
    try {
      this.record(await f());
      return ok(this.state());
    } catch (e) {
      return this.fail(e);
    } finally {
      this.busy--;
    }
  }

  pause() {
    return this.cmd(() => this.bridge.pause());
  }
  resume() {
    return this.cmd(() => this.bridge.resume());
  }
  seek(position: number) {
    if (!Number.isFinite(position)) return Promise.resolve(bad("position must be a number of seconds"));
    return this.cmd(() => this.bridge.seek(clampStudioSeek(position, this.last?.duration ?? null)));
  }

  /** `t` / Esc: stop Music.app (only if our track is still the one it holds) and end. Always ends, even when Music.app refuses. */
  async stop(): Promise<Result<StudioStateDto>> {
    const s = this.session;
    if (!s) return ok(this.state());
    this.busy++;
    try {
      const now = await this.bridge.state().catch(() => null);
      if (!now || now.persistentId === s.persistentId) await this.bridge.stop();
      this.end("stop");
      return ok(this.state());
    } catch (e) {
      const r = this.fail(e);
      return r;
    } finally {
      this.busy--;
    }
  }

  /** Poll rate: 4 Hz while the UI has an A-B loop running on the track, else 1 Hz. */
  setLoop(active: boolean): StudioStateDto {
    this.loop = active && !!this.session;
    this.schedule();
    return this.state();
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.autoPoll || !this.session) return;
    this.timer = setTimeout(() => void this.tick().finally(() => this.schedule()), this.loop ? this.loopPollMs : this.pollMs);
  }

  /** One poll (spec 7.1/7.4). Another persistent id, or `stopped`, once the grace after the play is over: Studio playback ends silently. */
  async tick(): Promise<void> {
    const s = this.session;
    if (!s || this.busy) return;
    let st: PlayerState;
    try {
      st = await this.bridge.state();
    } catch (e) {
      this.fail(e);
      return;
    }
    if (this.session !== s || this.busy) return; // a command ran meanwhile
    const young = Date.now() - s.startedAt < this.graceMs;
    if (young && (st.persistentId !== s.persistentId || st.state === "stopped")) return; // Music.app has not caught up with the play yet
    if (st.state === "stopped") return this.end("stopped"); // checked first: a stopped player has no current track either
    if (st.persistentId !== s.persistentId) return this.end("external");
    this.record(st);
  }
}
