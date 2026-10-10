// Ticket #27: Studio playback. The normalizer, the matcher's narrowing, absorption and stale-id demotion, the dump cache,
// the resident bridge against a fake child, the endpoints on a temp data dir with a fake dump and a fake bridge, and the
// key retargeting map. Nothing here talks to Music.app.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startApp, type App } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { openDb, type Db } from "../src/server/db";
import { runImport } from "../src/server/import";
import { BridgeRefused, ResidentBridge, type Bridge, type PlayerState, type PlayResult } from "../src/server/studio/bridge";
import { DumpCache, dumpRows, type DumpTrack } from "../src/server/studio/dump";
import { applyMatches, buildIndex, matchTrack, normalize, rematchTrack, type MirrorTrackInput } from "../src/server/studio/match";
import { keyAction } from "../src/shared/keymap";
import { studioRoute } from "../src/shared/studio";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const DUMP: DumpTrack[] = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "studio-dump.json"), "utf8")).tracks;
const S = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ---------------------------------------------------------------------------------------------------------------
describe("normalizer (spec 7.3)", () => {
  test("NFKD, diacritics, casefold", () => {
    expect(normalize("Türdai Mangnap  ORAR")).toBe("turdai mangnap orar");
    expect(normalize("Café")).toBe("cafe");
    expect(normalize("ＡＢＣ")).toBe("abc"); // NFKD folds the fullwidth forms
  });
  test("parentheticals are dropped, brackets too", () => {
    expect(normalize("Ezir-Kara (Last Stand of «Black Craw» Stallion)")).toBe("ezir kara");
    expect(normalize("Dyngyldai (Live) [Remastered]")).toBe("dyngyldai");
  });
  test("punctuation and whitespace collapse; trailing space is gone", () => {
    expect(normalize("Dyngyldai ")).toBe("dyngyldai");
    expect(normalize("Ay-Kherel:  The Music of Tuva")).toBe("ay kherel the music of tuva");
    expect(normalize("  a--b__c ")).toBe("a b c");
  });
  test("a title that is only a parenthetical keeps its text", () => {
    expect(normalize("(Intro)")).toBe("intro");
  });
  test("Cyrillic survives, with its diacritics folded", () => {
    expect(normalize("Хаян")).toBe("хаян");
    expect(normalize("Ёж")).toBe("еж");
  });
});

// ---------------------------------------------------------------------------------------------------------------
const mt = (over: Partial<MirrorTrackInput>): MirrorTrackInput => ({ id: "m", songId: "s", name: "", album: "", durationS: null, artists: [], ...over });
const index = buildIndex(DUMP);

describe("matcher narrowing (spec 7.3)", () => {
  test("one hit on (name, album) is a match", () => {
    const r = matchTrack(mt({ name: "Alash  Oglumga", album: "ACHAI" }), index);
    expect(r).toMatchObject({ kind: "match", via: "single", track: { persistentId: "T1" } });
  });
  test("the normalized key finds a parenthetical subtitle", () => {
    expect(matchTrack(mt({ name: "Dyngyldai", album: "Where Young Grass Grows" }), index)).toMatchObject({ kind: "match", track: { persistentId: "T2" } });
  });
  test("several hits: duration within 3 s picks one", () => {
    const r = matchTrack(mt({ name: "Barlyk River", album: "Best Live", durationS: 300, artists: [] }), index);
    expect(r).toMatchObject({ kind: "match", via: "duration", track: { persistentId: "T3" } });
  });
  test("several hits and no duration: artist tokens decide", () => {
    const r = matchTrack(mt({ name: "Barlyk River", album: "Best Live", artists: ["Huun-Huur-Tu"] }), index);
    expect(r).toMatchObject({ kind: "match", via: "artist", track: { persistentId: "T3" } });
    const r2 = matchTrack(mt({ name: "Throat Song", album: "Roots", artists: ["Kongar-ool Ondar"] }), index);
    expect(r2).toMatchObject({ kind: "match", via: "artist", track: { persistentId: "T7" } });
  });
  test("a Mirror duration that no hit is near falls through to the artist tokens", () => {
    const r = matchTrack(mt({ name: "Barlyk River", album: "Best Live", durationS: 20, artists: ["Alash"] }), index);
    expect(r).toMatchObject({ kind: "match", via: "artist", track: { persistentId: "T4" } });
  });
  test("a tie that duration and artists cannot settle is offered, never matched", () => {
    const r = matchTrack(mt({ name: "Kozhamyk", album: "Sketches", durationS: 201.5, artists: ["Ondar"] }), index);
    expect(r.kind).toBe("offer");
    if (r.kind === "offer") {
      expect(r.why).toBe("ambiguous");
      expect(r.candidates.map((c) => c.persistentId).sort()).toEqual(["T5", "T6"]);
    }
  });
  test("name-only hits are offered and never auto-matched", () => {
    const r = matchTrack(mt({ name: "Igil Solo", album: "Ay-Kherel: The Music of Tuva" }), index);
    expect(r).toMatchObject({ kind: "offer", why: "name-only" });
    if (r.kind === "offer") expect(r.candidates[0]!.persistentId).toBe("T10");
  });
  test("an album-less duplicate name is still only an offer", () => {
    expect(matchTrack(mt({ name: "Barlyk River", album: "Some Other Album", artists: ["Alash"] }), index).kind).toBe("offer");
  });
  test("no hit, and an unplayable (cloudStatus) track is not a candidate", () => {
    expect(matchTrack(mt({ name: "Nothing Here", album: "Void" }), index).kind).toBe("none");
    expect(matchTrack(mt({ name: "Lonely", album: "Gone" }), index).kind).toBe("none");
  });
});

// ---------------------------------------------------------------------------------------------------------------
function seed(db: Db) {
  db.exec(`
    INSERT INTO mirror_artist (id, name, is_hidden, is_various_artists) VALUES ('A1','Alash',0,0), ('A2','Huun-Huur-Tu',0,0), ('A3','Kongar-ool Ondar',0,0);
    INSERT INTO mirror_album (id, name, artist_id) VALUES ('AL1','Achai','A1'), ('AL2','Best Live','A2'), ('AL3','Sketches','A1'), ('AL4','Roots','A2'), ('AL5','Ay-Kherel: The Music of Tuva','A1'), ('AL6','The Music of Tuva','A1');
    INSERT INTO mirror_song (id, name, slug) VALUES ('${S(1)}','One','one'), ('${S(2)}','Two','two'), ('${S(3)}','Three','three'), ('${S(4)}','Four','four');
    INSERT INTO mirror_track (id, album_id, track_number, name, duration_s, song_id) VALUES
      ('M1','AL1',1,'Alash Oglumga',290,'${S(1)}'),
      ('M2','AL2',1,'Barlyk River',300,'${S(2)}'),
      ('M3','AL2',2,'Barlyk River',NULL,'${S(3)}'),
      ('M4','AL3',1,'Kozhamyk',202,'${S(4)}'),
      ('M5','AL4',1,'Throat Song',NULL,'${S(4)}'),
      ('M6','AL5',1,'Igil Solo',NULL,'${S(3)}'),
      ('M7','AL6',1,'Igil Solo',NULL,NULL);
    INSERT INTO mirror_track_artist (track_id, artist_id, position) VALUES ('M5','A3',0);
  `);
}
const rowsOf = (db: Db) => db.query("SELECT * FROM studio_track ORDER BY id").all() as any[];

describe("applyMatches on the DB (spec 7.3)", () => {
  test("Suggested rows for matches only, name-only and ties written nowhere, idempotent", () => {
    const db = openDb(":memory:", MIGRATIONS);
    seed(db);
    const s = applyMatches(db, DUMP);
    expect(s.tracks).toBe(7);
    expect(s.withSong).toBe(6);
    expect(s.matched).toEqual({ total: 5, single: 2, duration: 1, artist: 2 });
    expect(s.offered).toEqual({ total: 2, nameOnly: 1, ambiguous: 1 });
    expect(s.none).toBe(0);
    const rows = rowsOf(db);
    // M1->T1, M2->T3 (duration), M3->T3 (artist: shares the recording with M2 but on another Song), M5->T7; M7 has no Song
    expect(rows.map((r) => [r.mirror_track_id, r.persistent_id, r.suggested]).sort()).toEqual([["M1", "T1", 1], ["M2", "T3", 1], ["M3", "T3", 1], ["M5", "T7", 1]]);
    const again = applyMatches(db, DUMP);
    expect(again.inserted + again.updated + again.dropped + again.absorbed + again.demoted).toBe(0);
    expect(rowsOf(db).length).toBe(4);
    expect(s.songsWithStudio).toBe(4);
    db.close();
  });

  test("one match per Mirror Track, and a Song does not list one recording twice", () => {
    const db = openDb(":memory:", MIGRATIONS);
    seed(db);
    db.exec("INSERT INTO mirror_track (id, album_id, track_number, name, duration_s, song_id) VALUES ('M8','AL2',3,'Barlyk River',300,'" + S(2) + "')");
    applyMatches(db, DUMP);
    expect(rowsOf(db).filter((r) => r.song_id === S(2)).length).toBe(1);
    db.close();
  });

  test("absorption: a Local Studio track equal to a fresh match gains the mirror_track_id", () => {
    const db = openDb(":memory:", MIGRATIONS);
    seed(db);
    db.exec(`INSERT INTO studio_track (id, song_id, mirror_track_id, persistent_id, suggested, added_at) VALUES (50,'${S(1)}',NULL,'T1',0,'2026-01-01')`);
    db.exec(`INSERT INTO studio_last (song_id, studio_track_id) VALUES ('${S(1)}', 50)`);
    const s = applyMatches(db, DUMP);
    expect(s.absorbed).toBe(1);
    const r = rowsOf(db).filter((x) => x.song_id === S(1));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ id: 50, mirror_track_id: "M1", persistent_id: "T1", suggested: 0 }); // still the person's choice: confirmed
    expect(db.query("SELECT studio_track_id FROM studio_last WHERE song_id = ?").get(S(1))).toEqual({ studio_track_id: 50 });
    db.close();
  });

  test("absorption replaces a Suggested row for the same Track and keeps studio_last on the absorbed row", () => {
    const db = openDb(":memory:", MIGRATIONS);
    seed(db);
    applyMatches(db, DUMP);
    const sug = rowsOf(db).find((r) => r.mirror_track_id === "M1")!;
    // the person had added T1 locally *after* the suggestion existed
    db.exec(`INSERT INTO studio_track (id, song_id, mirror_track_id, persistent_id, suggested, added_at) VALUES (51,'${S(1)}',NULL,'T1',0,'2026-02-01')`);
    db.exec(`INSERT INTO studio_last (song_id, studio_track_id) VALUES ('${S(1)}', ${sug.id})`);
    applyMatches(db, DUMP);
    expect(rowsOf(db).filter((x) => x.song_id === S(1)).map((x) => [x.id, x.mirror_track_id])).toEqual([[51, "M1"]]);
    expect(db.query("SELECT studio_track_id FROM studio_last WHERE song_id = ?").get(S(1))).toEqual({ studio_track_id: 51 });
    db.close();
  });

  test("stale id: a confirmed match whose id left the dump resolves differently and drops to Suggested", () => {
    const db = openDb(":memory:", MIGRATIONS);
    seed(db);
    db.exec(`INSERT INTO studio_track (id, song_id, mirror_track_id, persistent_id, suggested, added_at) VALUES (60,'${S(2)}','M2','OLD',0,'x')`);
    const s = applyMatches(db, DUMP);
    expect(s.demoted).toBe(1);
    expect(rowsOf(db).find((r) => r.id === 60)).toMatchObject({ persistent_id: "T3", suggested: 1 });
    db.close();
  });

  test("a confirmed match whose id is still in the dump stands, even if the matcher would pick another", () => {
    const db = openDb(":memory:", MIGRATIONS);
    seed(db);
    db.exec(`INSERT INTO studio_track (id, song_id, mirror_track_id, persistent_id, suggested, added_at) VALUES (61,'${S(2)}','M2','T4',0,'x')`);
    applyMatches(db, DUMP);
    expect(rowsOf(db).find((r) => r.id === 61)).toMatchObject({ persistent_id: "T4", suggested: 0 });
    db.close();
  });

  test("a confirmed stale id with no fresh match is left alone and counted", () => {
    const db = openDb(":memory:", MIGRATIONS);
    seed(db);
    db.exec(`INSERT INTO studio_track (id, song_id, mirror_track_id, persistent_id, suggested, added_at) VALUES (62,'${S(4)}','M4','GONE',0,'x')`);
    const s = applyMatches(db, DUMP);
    expect(s.stale).toBe(1);
    expect(rowsOf(db).find((r) => r.id === 62)).toMatchObject({ persistent_id: "GONE", suggested: 0 });
    db.close();
  });

  test("a Suggested row follows the dump: updated when the match moves, dropped when it vanishes", () => {
    const db = openDb(":memory:", MIGRATIONS);
    seed(db);
    db.exec(`INSERT INTO studio_track (id, song_id, mirror_track_id, persistent_id, suggested, added_at) VALUES (70,'${S(1)}','M1','OLD',1,'x'), (71,'${S(4)}','M4','OLD2',1,'x')`);
    db.exec(`INSERT INTO studio_last (song_id, studio_track_id) VALUES ('${S(4)}', 71)`);
    const s = applyMatches(db, DUMP);
    expect(s.updated).toBe(1);
    expect(s.dropped).toBe(1);
    expect(rowsOf(db).find((r) => r.id === 70)?.persistent_id).toBe("T1");
    expect(rowsOf(db).find((r) => r.id === 71)).toBeUndefined();
    expect(db.query("SELECT * FROM studio_last WHERE song_id = ?").get(S(4))).toBeNull();
    db.close();
  });

  test("a rejected pair is never suggested again; a different candidate still can be", () => {
    const db = openDb(":memory:", MIGRATIONS);
    seed(db);
    db.exec("INSERT INTO studio_rejection (mirror_track_id, persistent_id) VALUES ('M1','T1')");
    const s = applyMatches(db, DUMP);
    expect(s.rejectedSkipped).toBe(1);
    expect(rowsOf(db).some((r) => r.mirror_track_id === "M1")).toBe(false);
    db.close();
  });

  test("rematchTrack touches only that Track", () => {
    const db = openDb(":memory:", MIGRATIONS);
    seed(db);
    const s = rematchTrack(db, DUMP, "M1");
    expect(s.tracks).toBe(1);
    expect(rowsOf(db).map((r) => r.mirror_track_id)).toEqual(["M1"]);
    db.close();
  });

  test("runImport with an injected dump runs the matcher; without one under `bun test` it is skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tuva-studio-imp-"));
    const db = openDb(":memory:", MIGRATIONS);
    const FIXTURE = join(import.meta.dir, "fixtures", "backup");
    const skipped = await runImport(db, FIXTURE);
    expect(skipped.studio).toBeNull();
    const dump = new DumpCache(join(dir, "d.json"), async () => DUMP);
    const run = await runImport(db, FIXTURE, { dump });
    expect(run.studio).not.toBeNull();
    expect(run.studio!.tracks).toBeGreaterThan(0);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("dump cache", () => {
  test("columns become rows; a refresh writes the file; a second cache reads it; a miss refreshes", async () => {
    const rows = dumpRows({ id: ["a", "b"], name: ["x", "y"], album: ["", "z"], artist: ["p", "q"], albumArtist: ["", ""], duration: [1.5, null], cloud: ["subscription", "matched"] });
    expect(rows[1]).toEqual({ persistentId: "b", name: "y", album: "z", artist: "q", albumArtist: "", duration: 0, cloudStatus: "matched" });
    const dir = mkdtempSync(join(tmpdir(), "tuva-dump-"));
    const path = join(dir, "studio-dump.json");
    let calls = 0;
    const c = new DumpCache(path, async () => (calls++, rows));
    expect(c.peek()).toBeNull();
    const f = await c.get();
    expect(f.tracks).toHaveLength(2);
    expect(calls).toBe(1);
    await c.get();
    expect(calls).toBe(1);
    expect(new DumpCache(path, async () => []).peek()?.tracks).toHaveLength(2);
    expect(c.byId("b")?.name).toBe("y");
    // refresh within the 5 s window is reused unless forced; concurrent callers share one read
    await c.refresh();
    expect(calls).toBe(1);
    await Promise.all([c.refresh(true), c.refresh(true)]);
    expect(calls).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("resident bridge (a fake child speaking the same protocol)", () => {
  const argv = ["bun", join(import.meta.dir, "fixtures", "fake-bridge.ts")];
  test("answers, restarts after the child dies, and a command that never answers is refused", async () => {
    const b = new ResidentBridge({ argv, timeoutMs: 600 });
    const s1 = await b.state();
    expect(s1).toMatchObject({ state: "playing", position: 12.5, duration: 200, persistentId: "AAAA" });
    expect(b.starts).toBe(1);
    expect((await b.play("GONE")).found).toBe(false);
    expect((await b.play("X")).found).toBe(true);
    // death: the in-flight command is refused, the next one restarts the child
    await expect((b as any).send("die")).rejects.toBeInstanceOf(BridgeRefused);
    expect(await b.state()).toMatchObject({ state: "playing" });
    expect(b.starts).toBe(2);
    // a script error is refused with its text
    await expect((b as any).send("fail")).rejects.toThrow(/boom/);
    // a hang: refused after the timeout, child killed, next command works on a fresh child
    const t0 = Date.now();
    await expect((b as any).send("hang")).rejects.toBeInstanceOf(BridgeRefused);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await b.state()).toMatchObject({ state: "playing" });
    expect(b.starts).toBe(3);
    b.close();
    await expect(b.state()).rejects.toBeInstanceOf(BridgeRefused);
  });
  test("a child that cannot start is refused, not thrown", async () => {
    const b = new ResidentBridge({ argv: ["/nonexistent/osascript"], timeoutMs: 500 });
    await expect(b.state()).rejects.toBeInstanceOf(BridgeRefused);
    b.close();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("key retargeting while the bar is active (spec 7.4)", () => {
  const route = (key: string, shiftKey = false) => studioRoute(keyAction({ key, shiftKey })!);
  test("space, p, arrows and l go to Music.app", () => {
    expect(route(" ")).toEqual({ to: "music", op: "toggle" });
    expect(route("p")).toEqual({ to: "music", op: "toggle" });
    expect(route("ArrowRight")).toEqual({ to: "music", op: { seek: 5 } });
    expect(route("ArrowLeft")).toEqual({ to: "music", op: { seek: -5 } });
    expect(route("ArrowUp")).toEqual({ to: "music", op: { seek: 60 } });
    expect(route("ArrowDown")).toEqual({ to: "music", op: { seek: -60 } });
    expect(route("ArrowRight", true)).toEqual({ to: "music", op: { seek: 1 } });
    expect(route("l")).toEqual({ to: "music", op: "loop" });
  });
  test("9 0 m stay on the browser; t leaves", () => {
    for (const k of ["9", "0", "m"]) expect(route(k)).toEqual({ to: "browser" });
    expect(route("t")).toEqual({ to: "exit" });
  });
  test("every other binding is a no-op with a notice", () => {
    for (const k of ["f", "s", ".", ",", "[", "]", "{", "}", "Backspace", "!", "@", "PageUp", "<", ">", "c", "o", "O"]) {
      expect(route(k)).toMatchObject({ to: "noop" });
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------
class FakeBridge implements Bridge {
  /** persistent ids Music.app "has". */
  library = new Set(["T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T10", "NEW3"]);
  s: PlayerState = { state: "stopped", position: null, duration: null, persistentId: null };
  log: string[] = [];
  refuse = false;
  private chk() {
    if (this.refuse) throw new BridgeRefused("not allowed");
  }
  async state() {
    this.chk();
    return { ...this.s };
  }
  async play(id: string): Promise<PlayResult> {
    this.chk();
    this.log.push(`play ${id}`);
    if (!this.library.has(id)) return { found: false, ...this.s };
    this.s = { state: "playing", position: 0, duration: 250, persistentId: id };
    return { found: true, ...this.s };
  }
  async pause() {
    this.chk();
    this.log.push("pause");
    this.s = { ...this.s, state: "paused" };
    return { ...this.s };
  }
  async resume() {
    this.chk();
    this.log.push("resume");
    this.s = { ...this.s, state: "playing" };
    return { ...this.s };
  }
  async seek(sec: number) {
    this.chk();
    this.log.push(`seek ${sec}`);
    this.s = { ...this.s, position: sec };
    return { ...this.s };
  }
  async stop() {
    this.chk();
    this.log.push("stop");
    this.s = { state: "stopped", position: null, duration: null, persistentId: null };
    return { ...this.s };
  }
  close() {}
}

const base = mkdtempSync(join(tmpdir(), "tuva-studio-"));
mkdirSync(join(base, "local"), { recursive: true });
mkdirSync(join(base, "ext"), { recursive: true });
let app: App;
let url: string;
const bridge = new FakeBridge();
let dumpTracks: DumpTrack[] = DUMP;
let dumpReads = 0;
const call = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(url + path, { method, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: (await r.json()) as any };
};

describe("Studio endpoints (fake dump, fake bridge)", () => {
  beforeAll(async () => {
    const cfg = loadConfig({ TUVA_DATA_DIR: join(base, "data"), TUVA_PORT: "0", TUVA_NO_OPEN: "1", TUVA_LOCAL_ROOT: join(base, "local"), TUVA_EXTERNAL_ROOT: join(base, "ext") });
    const dump = new DumpCache(cfg.studioDumpPath, async () => (dumpReads++, dumpTracks));
    app = await startApp(cfg, { studio: { bridge, dump, autoPoll: false, graceMs: 0 } });
    url = `http://localhost:${app.server.port}`;
    seed(app.db);
    applyMatches(app.db, DUMP);
  }, 30_000);
  afterAll(async () => {
    await app.stop();
    rmSync(base, { recursive: true, force: true });
  });

  test("GET /api/songs/:id/studio lists matches in order, then missing Tracks with offers; unknown Song is empty", async () => {
    const r = (await call("GET", `/api/songs/${S(3)}/studio`)).body;
    expect(r.tracks.map((t: any) => [t.mirrorTrackId, t.persistentId, t.state, t.name])).toEqual([["M3", "T3", "suggested", "Barlyk River"]]);
    expect(r.missing.map((m: any) => m.mirrorTrackId)).toEqual(["M6"]);
    expect(r.missing[0].offers.map((o: any) => o.persistentId)).toEqual(["T10"]); // name-only: offered
    expect(r.lastId).toBeNull();
    expect((await call("GET", `/api/songs/${S(9)}/studio`)).body).toMatchObject({ tracks: [], missing: [] });
  });

  test("a Song's order: matched Mirror Tracks by album then track number, then Local Studio tracks by added_at", async () => {
    const add1 = await call("POST", `/api/songs/${S(4)}/studio`, { persistentId: "T8" });
    expect(add1.status).toBe(201);
    const add2 = await call("POST", `/api/songs/${S(4)}/studio`, { persistentId: "T2" });
    expect(add2.status).toBe(201);
    expect((await call("POST", `/api/songs/${S(4)}/studio`, { persistentId: "T8" })).status).toBe(409);
    expect((await call("POST", `/api/songs/${S(4)}/studio`, { persistentId: "NOPE" })).status).toBe(404);
    const r = (await call("GET", `/api/songs/${S(4)}/studio`)).body;
    expect(r.tracks.map((t: any) => [t.kind, t.persistentId])).toEqual([["mirror", "T7"], ["local", "T8"], ["local", "T2"]]);
    expect(r.missing.map((m: any) => m.mirrorTrackId)).toEqual(["M4"]); // the tie: offered, with both candidates
    expect(r.missing[0].offers.map((o: any) => o.persistentId).sort()).toEqual(["T5", "T6"]);
  });

  test("search runs over the dump, folded, unplayable left out", async () => {
    expect((await call("GET", "/api/studio/search?q=barlyk")).body.results.map((x: any) => x.persistentId).sort()).toEqual(["T3", "T4"]);
    expect((await call("GET", "/api/studio/search?q=achai%20alash")).body.results.map((x: any) => x.persistentId)).toEqual(["T1"]);
    expect((await call("GET", "/api/studio/search?q=lonely")).body.results).toEqual([]);
    expect((await call("GET", "/api/studio/search?q=")).body.results).toEqual([]);
  });

  test("match a Track by hand (confirmed), confirm and reject a Suggested one", async () => {
    const m = await call("POST", "/api/tracks/M4/match", { persistentId: "T5" });
    expect(m.status).toBe(200);
    let r = (await call("GET", `/api/songs/${S(4)}/studio`)).body;
    expect(r.tracks.find((t: any) => t.mirrorTrackId === "M4")).toMatchObject({ persistentId: "T5", state: "confirmed", kind: "mirror" });
    expect(r.missing).toEqual([]);
    expect((await call("POST", "/api/tracks/NOPE/match", { persistentId: "T5" })).status).toBe(404);
    expect((await call("POST", "/api/tracks/M7/match", { persistentId: "T5" })).status).toBe(409); // no Song
    expect((await call("POST", "/api/tracks/M4/match", { persistentId: "NOPE" })).status).toBe(404);

    const sug = (await call("GET", `/api/songs/${S(1)}/studio`)).body.tracks[0];
    expect(sug.state).toBe("suggested");
    expect((await call("POST", `/api/studio-tracks/${sug.id}/confirm`)).status).toBe(200);
    expect((await call("GET", `/api/songs/${S(1)}/studio`)).body.tracks[0].state).toBe("confirmed");
    expect((await call("POST", "/api/studio-tracks/99999/confirm")).status).toBe(404);

    const m3 = (await call("GET", `/api/songs/${S(3)}/studio`)).body.tracks[0];
    const del = await call("DELETE", `/api/studio-tracks/${m3.id}`);
    expect(del.body).toEqual({ removed: true, tombstoned: true });
    applyMatches(app.db, DUMP); // the next import must not bring it back
    r = (await call("GET", `/api/songs/${S(3)}/studio`)).body;
    expect(r.tracks).toEqual([]);
    expect(r.missing.map((x: any) => x.mirrorTrackId).sort()).toEqual(["M3", "M6"]);
    expect((await call("DELETE", "/api/studio-tracks/99999")).status).toBe(404);
  });

  test("a hand match that equals a Local Studio track absorbs it", async () => {
    const before = (await call("GET", `/api/songs/${S(4)}/studio`)).body.tracks.filter((t: any) => t.kind === "local").length;
    const rows = app.db.query("SELECT id FROM studio_track WHERE song_id = ? AND persistent_id = 'T8'").all(S(4)) as any[];
    expect(rows).toHaveLength(1);
    // M5's Suggested T7 is replaced by the Local T8: one row stays, now bound to M5
    await call("POST", "/api/tracks/M5/match", { persistentId: "T8" });
    const r = (await call("GET", `/api/songs/${S(4)}/studio`)).body;
    expect(r.tracks.filter((t: any) => t.kind === "local")).toHaveLength(before - 1);
    expect(r.tracks.find((t: any) => t.mirrorTrackId === "M5")).toMatchObject({ id: rows[0].id, persistentId: "T8", state: "confirmed" });
  });

  test("play: Music.app gets the persistent id, studio_last is set, state is served, once-play end is silent", async () => {
    const tr = (await call("GET", `/api/songs/${S(1)}/studio`)).body.tracks[0];
    const p = await call("POST", "/api/studio/play", { studioTrackId: tr.id });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ active: true, studioTrackId: tr.id, persistentId: "T1", name: "Alash Oglumga", album: "Achai", state: "playing", duration: 250, ended: null });
    expect(bridge.log.at(-1)).toBe("play T1");
    expect((await call("GET", `/api/songs/${S(1)}/studio`)).body.lastId).toBe(tr.id);

    expect((await call("POST", "/api/studio/pause")).body).toMatchObject({ state: "paused" });
    expect((await call("POST", "/api/studio/resume")).body).toMatchObject({ state: "playing" });
    expect((await call("POST", "/api/studio/seek", { position: 83.5 })).body).toMatchObject({ position: 83.5 });
    expect((await call("POST", "/api/studio/seek", { position: 99999 })).body).toMatchObject({ position: 250 }); // clamped to the track
    expect((await call("POST", "/api/studio/seek", { position: "x" })).status).toBe(400);
    expect((await call("GET", "/api/studio/state")).body).toMatchObject({ active: true, position: 250 });

    // the once-play ran out: Music.app is stopped -> ended silently
    bridge.s = { state: "stopped", position: null, duration: null, persistentId: null };
    await app.studio.tick();
    expect((await call("GET", "/api/studio/state")).body).toMatchObject({ active: false, ended: "stopped", refused: null });
    expect((await call("POST", "/api/studio/pause")).status).toBe(409);
  });

  test("external change: another persistent id in Music.app ends Studio playback and does not stop it", async () => {
    const tr = (await call("GET", `/api/songs/${S(1)}/studio`)).body.tracks[0];
    await call("POST", "/api/studio/play", { studioTrackId: tr.id });
    bridge.s = { state: "playing", position: 5, duration: 100, persistentId: "SOMETHING-ELSE" };
    await app.studio.tick();
    expect((await call("GET", "/api/studio/state")).body).toMatchObject({ active: false, ended: "external" });
    bridge.log.length = 0;
    await call("POST", "/api/studio/stop");
    expect(bridge.log).toEqual([]); // nothing of ours to stop
  });

  test("stop (t, Esc) stops Music.app when our track is still the one it holds", async () => {
    const tr = (await call("GET", `/api/songs/${S(1)}/studio`)).body.tracks[0];
    await call("POST", "/api/studio/play", { studioTrackId: tr.id });
    const s = await call("POST", "/api/studio/stop");
    expect(s.body).toMatchObject({ active: false, ended: "stop" });
    expect(bridge.log.at(-1)).toBe("stop");
  });

  test("stale persistent id: play misses, the dump is re-read, the Track is re-matched, the new id plays", async () => {
    // the library was rebuilt: T3 became NEW3
    const m2 = (await call("GET", `/api/songs/${S(2)}/studio`)).body.tracks[0];
    expect(m2).toMatchObject({ mirrorTrackId: "M2", persistentId: "T3" });
    await call("POST", `/api/studio-tracks/${m2.id}/confirm`);
    bridge.library.delete("T3");
    dumpTracks = DUMP.map((t) => (t.persistentId === "T3" ? { ...t, persistentId: "NEW3" } : t));
    const reads = dumpReads;
    const p = await call("POST", "/api/studio/play", { studioTrackId: m2.id });
    expect(p.status).toBe(200);
    expect(dumpReads).toBe(reads + 1);
    expect(p.body).toMatchObject({ active: true, persistentId: "NEW3" });
    const after = (await call("GET", `/api/songs/${S(2)}/studio`)).body.tracks[0];
    expect(after).toMatchObject({ id: m2.id, persistentId: "NEW3", state: "suggested" }); // confirmed -> drops to Suggested
    await call("POST", "/api/studio/stop");
  });

  test("a Local Studio track whose id is gone for good: 404 with no phantom playback", async () => {
    const r = (await call("GET", `/api/songs/${S(4)}/studio`)).body;
    const local = r.tracks.find((t: any) => t.kind === "local");
    bridge.library.delete(local.persistentId);
    dumpTracks = dumpTracks.filter((t) => t.persistentId !== local.persistentId);
    const p = await call("POST", "/api/studio/play", { studioTrackId: local.id });
    expect(p.status).toBe(404);
    expect((await call("GET", "/api/studio/state")).body.active).toBe(false);
    const again = (await call("GET", `/api/songs/${S(4)}/studio`)).body;
    expect(again.tracks.find((t: any) => t.id === local.id)).toMatchObject({ state: "missing" });
  });

  test("a refused command surfaces as refused (502) and ends Studio playback", async () => {
    const tr = (await call("GET", `/api/songs/${S(1)}/studio`)).body.tracks[0];
    await call("POST", "/api/studio/play", { studioTrackId: tr.id });
    bridge.refuse = true;
    const p = await call("POST", "/api/studio/pause");
    expect(p.status).toBe(502);
    expect(p.body).toMatchObject({ refused: true, error: "Music.app refused — check System Settings › Automation" });
    expect((await call("GET", "/api/studio/state")).body).toMatchObject({ active: false, ended: "refused", refused: "Music.app refused — check System Settings › Automation" });
    const q = await call("POST", "/api/studio/play", { studioTrackId: tr.id });
    expect(q.status).toBe(502);
    bridge.refuse = false;
  });

  test("bad bodies are 400s", async () => {
    expect((await call("POST", "/api/studio/play", {})).status).toBe(400);
    expect((await call("POST", `/api/songs/${S(1)}/studio`, {})).status).toBe(400);
    expect((await call("POST", "/api/tracks/M1/match", {})).status).toBe(400);
    expect((await call("POST", "/api/studio/play", { studioTrackId: 424242 })).status).toBe(404);
  });
});
