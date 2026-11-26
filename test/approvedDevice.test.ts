// Library Server: the approved_tv -> approved_device migration (docs/home-server-spec.md §3) and the health answer (§2.1).
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/server/db";
import { HEALTH_APP, healthBody } from "../src/server/libraryServerHealth";
import { TvServer } from "../src/server/tv";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");

describe("0025 approved_device", () => {
  test("every existing Approved TV row becomes kind 'tv', via 'click', keeping its facts", () => {
    const dir = mkdtempSync(join(tmpdir(), "tuva-mig-"));
    for (const f of readdirSync(MIGRATIONS)) if (f < "0025") cpSync(join(MIGRATIONS, f), join(dir, f));
    const db = new Database(":memory:");
    migrate(db, dir);
    db.exec(`INSERT INTO approved_tv (ip, model, approved_at, last_seen_at) VALUES ('192.168.4.56', 'Samsung 85R85H', '2026-01-01T00:00:00Z', '2026-02-02T00:00:00Z');
      INSERT INTO approved_tv (ip, model, approved_at, last_seen_at) VALUES ('192.168.4.57', NULL, '2026-01-03T00:00:00Z', NULL);`);
    migrate(db, MIGRATIONS);
    expect(db.query("SELECT 1 FROM sqlite_master WHERE name = 'approved_tv'").get()).toBeNull();
    expect((db.query("PRAGMA table_info(approved_device)").all() as { name: string }[]).map((c) => c.name)).toEqual([
      "ip", "kind", "name", "model", "via", "tailscale_login", "approved_at", "last_seen_at",
    ]);
    expect(db.query("SELECT * FROM approved_device ORDER BY ip").all()).toEqual([
      { ip: "192.168.4.56", kind: "tv", name: null, model: "Samsung 85R85H", via: "click", tailscale_login: null, approved_at: "2026-01-01T00:00:00Z", last_seen_at: "2026-02-02T00:00:00Z" },
      { ip: "192.168.4.57", kind: "tv", name: null, model: null, via: "click", tailscale_login: null, approved_at: "2026-01-03T00:00:00Z", last_seen_at: null },
    ]);
    expect(() => db.exec("INSERT INTO approved_device (ip, kind, via, approved_at) VALUES ('1.1.1.1', 'phone', 'click', 'x')")).toThrow();
    rmSync(dir, { recursive: true, force: true });
  });

  test("approve / approved / remove go through approved_device", () => {
    const db = new Database(":memory:");
    migrate(db, MIGRATIONS);
    const tv = new TvServer({ cfg: { tvPort: 0, passive: false, webDir: "" }, db: db as never });
    expect(tv.approve("192.168.4.56")).toBe(true);
    expect(tv.approved()).toMatchObject([{ ip: "192.168.4.56", kind: "tv", name: null, via: "click", lastSeenAt: null }]);
    expect(tv.remove("192.168.4.56")).toBe(true);
    expect(tv.approved()).toEqual([]);
  });
});

describe("health", () => {
  const f = { name: "mac-mini", home: true, version: "abc1234" };
  test("keeps the wire string and adds name, home, drive, version", () => {
    expect(healthBody({ ...f, rootsMounted: [true] })).toEqual({ app: "TuvaVideos TV Server", name: "mac-mini", home: true, drive: "mounted", version: "abc1234" });
    expect(HEALTH_APP).toBe("TuvaVideos TV Server");
  });
  test("drive is mounted when any Root is, unmounted when none is or there are none", () => {
    expect(healthBody({ ...f, rootsMounted: [false, true] }).drive).toBe("mounted");
    expect(healthBody({ ...f, rootsMounted: [false, false] }).drive).toBe("unmounted");
    expect(healthBody({ ...f, rootsMounted: [] }).drive).toBe("unmounted");
  });
  test("the server's answer reads Roots and the home flag", () => {
    const roots = { list: () => [{ id: 1, path: "/a", kind: "local" as const }], isAvailable: () => false };
    const tv = new TvServer({ cfg: { tvPort: 0, passive: false, webDir: "" }, db: null as never, roots, home: () => true });
    expect(tv.health()).toMatchObject({ app: "TuvaVideos TV Server", home: true, drive: "unmounted" });
  });
});
