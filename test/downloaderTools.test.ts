// Downloader tools (docs/downloader-spec.md §2): asset choice, checksum files, lookup order, ffmpeg location, the
// install with downloads mocked, the daily self-update gate.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { findDownloaderBin } from "../src/server/config";
import { openDb } from "../src/server/db";
import {
  checksumFor,
  denoAsset,
  ffmpegLocation,
  hasImpersonation,
  jsRuntimeArgs,
  parseVersion,
  singleChecksum,
  unzipFirstFile,
  versionAtLeast,
  ytdlpAsset,
} from "../src/server/downloads/tools";
import { createDownloaderTools, getSetting, isDue, setSetting } from "../src/server/downloads/toolsInstall";

const MIGRATIONS = join(import.meta.dir, "..", "migrations");
const tmp = () => mkdtempSync(join(tmpdir(), "tuva-tools-"));
const sha = (b: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(b).digest("hex");

test("asset choice per platform and arch", () => {
  expect(ytdlpAsset("darwin", "arm64")).toBe("yt-dlp_macos");
  expect(ytdlpAsset("darwin", "x64")).toBe("yt-dlp_macos");
  expect(ytdlpAsset("linux", "x64")).toBe("yt-dlp_linux");
  expect(ytdlpAsset("linux", "arm64")).toBe("yt-dlp_linux_aarch64");
  expect(ytdlpAsset("win32", "x64")).toBe("yt-dlp.exe");
  expect(ytdlpAsset("win32", "arm64")).toBe("yt-dlp_arm64.exe");
  expect(ytdlpAsset("freebsd", "x64")).toBeNull();
  expect(ytdlpAsset("linux", "ia32")).toBeNull();
  expect(denoAsset("darwin", "arm64")).toBe("deno-aarch64-apple-darwin.zip");
  expect(denoAsset("darwin", "x64")).toBe("deno-x86_64-apple-darwin.zip");
  expect(denoAsset("linux", "x64")).toBe("deno-x86_64-unknown-linux-gnu.zip");
  expect(denoAsset("linux", "arm64")).toBe("deno-aarch64-unknown-linux-gnu.zip");
  expect(denoAsset("win32", "x64")).toBe("deno-x86_64-pc-windows-msvc.zip");
  expect(denoAsset("win32", "arm64")).toBe("deno-aarch64-pc-windows-msvc.zip");
  expect(denoAsset("linux", "ia32")).toBeNull();
});

test("checksum lines", () => {
  const a = "a".repeat(64);
  const b = "B".repeat(64);
  const sums = `${a}  yt-dlp\n${b} *yt-dlp_macos\n${"c".repeat(64)}  yt-dlp_macos_legacy\r\n`;
  expect(checksumFor(sums, "yt-dlp_macos")).toBe("b".repeat(64));
  expect(checksumFor(sums, "yt-dlp")).toBe(a);
  expect(checksumFor(sums, "yt-dlp_linux")).toBeNull();
  expect(checksumFor("not a hash  yt-dlp_macos", "yt-dlp_macos")).toBeNull();
  expect(singleChecksum(`${a}  deno-x.zip\n`)).toBe(a);
  expect(singleChecksum(`${a}\n`)).toBe(a);
  expect(singleChecksum("<html>")).toBeNull();
});

test("versions and runtime arguments", () => {
  expect(parseVersion("deno 2.9.8 (stable, release, aarch64-apple-darwin)")).toEqual([2, 9, 8]);
  expect(parseVersion("v22.11.0")).toEqual([22, 11, 0]);
  expect(parseVersion("2025.10.22")).toEqual([2025, 10, 22]);
  expect(parseVersion("nothing")).toBeNull();
  expect(versionAtLeast([2, 3, 0], [2, 3, 0])).toBe(true);
  expect(versionAtLeast([2, 2, 9], [2, 3, 0])).toBe(false);
  expect(versionAtLeast([3, 0, 0], [2, 3, 0])).toBe(true);
  expect(versionAtLeast(null, [2, 3, 0])).toBe(false);
  expect(jsRuntimeArgs({ kind: "node", path: "/usr/bin/node", version: "22.1.0", app: false })).toEqual(["--js-runtimes", "node"]);
  expect(jsRuntimeArgs({ kind: "deno", path: "/x/bin/deno", version: "2.9.8", app: true })).toEqual(["--js-runtimes", "deno:/x/bin/deno"]);
  expect(jsRuntimeArgs({ kind: "deno", path: "/usr/bin/deno", version: "2.9.8", app: false })).toEqual([]);
  expect(jsRuntimeArgs({ kind: "none", path: null, version: null, app: false })).toEqual([]);
});

test("impersonation targets output", () => {
  const ok = "[info] Available impersonate targets\nClient          OS         Source\n---------------------------------------\nChrome          -          curl_cffi\nSafari          macos-14   curl_cffi\n";
  const none = "[info] Available impersonate targets\nClient          OS         Source\n---------------------------------------\nChrome          -          curl_cffi (unavailable)\n";
  const real = "[info] Available impersonate targets\nClient          OS           Source\n--------------------------------------\nChrome-133      Macos-15     curl_cffi\nSafari-17.2     Ios-17.2     curl_cffi\n";
  expect(hasImpersonation(real)).toBe(true);
  expect(hasImpersonation(ok)).toBe(true);
  expect(hasImpersonation(none)).toBe(false);
  expect(hasImpersonation("")).toBe(false);
});

test("lookup order: TUVA_BIN_DIR, app bin, Homebrew, PATH", () => {
  const have = (...paths: string[]) => (p: string) => paths.includes(p);
  const env = { TUVA_BIN_DIR: "/mine", PATH: "" };
  expect(findDownloaderBin("yt-dlp", "/data", env, have("/mine/yt-dlp", "/data/bin/yt-dlp", "/opt/homebrew/bin/yt-dlp"))).toBe("/mine/yt-dlp");
  expect(findDownloaderBin("yt-dlp", "/data", env, have("/data/bin/yt-dlp", "/opt/homebrew/bin/yt-dlp"))).toBe("/data/bin/yt-dlp");
  expect(findDownloaderBin("yt-dlp", "/data", {}, have("/opt/homebrew/bin/yt-dlp", "/usr/local/bin/yt-dlp"))).toBe("/opt/homebrew/bin/yt-dlp");
  expect(findDownloaderBin("yt-dlp", "/data", {}, have("/usr/local/bin/yt-dlp"))).toBe("/usr/local/bin/yt-dlp");
  expect(findDownloaderBin("yt-dlp-no-such-thing", "/data", { PATH: "" }, have())).toBeNull();
});

test("PATH is the last place looked", () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, "tuva-fake-tool"), "#!/bin/sh\n");
    chmodSync(join(dir, "tuva-fake-tool"), 0o755);
    expect(findDownloaderBin("tuva-fake-tool", "/nonexistent", { PATH: dir })).toBe(join(dir, "tuva-fake-tool"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ffmpeg location: shared directory, or the file plus ffprobe's directory on PATH", () => {
  expect(ffmpegLocation("/opt/homebrew/bin/ffmpeg", "/opt/homebrew/bin/ffprobe", "/usr/bin")).toEqual({ args: ["--ffmpeg-location", "/opt/homebrew/bin"], env: {} });
  expect(ffmpegLocation("/a/ffmpeg", "/b/ffprobe", "/usr/bin")).toEqual({ args: ["--ffmpeg-location", "/a/ffmpeg"], env: { PATH: "/b:/usr/bin" } });
  expect(ffmpegLocation("/a/ffmpeg", "/b/ffprobe", "").env.PATH).toBe("/b");
});

/** A one-entry zip (deflated), as a release archive holds `deno`. */
function zipOf(name: string, data: Uint8Array): Uint8Array {
  const raw = Buffer.from(deflateRawSync(data));
  const nm = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(raw.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nm.length, 26);
  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(8, 10);
  cen.writeUInt32LE(raw.length, 20);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt16LE(nm.length, 28);
  const offset = 0;
  cen.writeUInt32LE(offset, 42);
  const body = Buffer.concat([local, nm, raw]);
  const dir = Buffer.concat([cen, nm]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(body.length, 16);
  return new Uint8Array(Buffer.concat([body, dir, end]));
}

test("unzip reads a deflated entry", () => {
  const payload = new TextEncoder().encode("#!/bin/sh\necho deno 2.9.8\n".repeat(50));
  const out = unzipFirstFile(zipOf("deno", payload));
  expect(out.name).toBe("deno");
  expect(Buffer.from(out.data).equals(Buffer.from(payload))).toBe(true);
  expect(() => unzipFirstFile(new Uint8Array(40))).toThrow();
});

test("0023 creates download_setting", () => {
  const dir = tmp();
  try {
    const db = openDb(join(dir, "t.db"), MIGRATIONS);
    setSetting(db, "k", "1");
    setSetting(db, "k", "2");
    expect(getSetting(db, "k")).toBe("2");
    expect(getSetting(db, "missing")).toBeNull();
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("due: missing, stale, fresh", () => {
  const t = Date.parse("2026-11-08T12:00:00Z");
  expect(isDue(null, t, 1000)).toBe(true);
  expect(isDue("garbage", t, 1000)).toBe(true);
  expect(isDue("2026-11-08T11:59:00Z", t, 3600_000)).toBe(false);
  expect(isDue("2026-11-08T10:00:00Z", t, 3600_000)).toBe(true);
});

const FAKE_YTDLP = "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 2026.01.01; exit 0; fi\nif [ \"$1\" = \"-U\" ]; then echo 'Latest version: 2026.02.02'; exit 0; fi\nexit 0\n";

function fakeFetch(files: Record<string, Uint8Array | string>, hits: string[] = []) {
  return async (url: string): Promise<Response> => {
    hits.push(url);
    const body = files[url];
    return body === undefined ? new Response("no", { status: 404 }) : new Response(body as BodyInit);
  };
}

test("install: checksum verified, atomic, a mismatch installs nothing", async () => {
  const dir = tmp();
  const db = openDb(join(dir, "t.db"), MIGRATIONS);
  try {
    const asset = ytdlpAsset(process.platform, process.arch)!;
    const base = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
    const bad = createDownloaderTools({
      dataDir: dir, db, env: { PATH: "" }, exists: (p) => p.startsWith(dir) && existsSync(p),
      fetch: fakeFetch({ [`${base}/SHA2-256SUMS`]: `${"0".repeat(64)}  ${asset}\n`, [`${base}/${asset}`]: FAKE_YTDLP }),
    });
    await bad.installMissing();
    expect((await bad.status()).install.error).toBe("yt-dlp download failed its checksum");
    expect(existsSync(join(dir, "bin", "yt-dlp"))).toBe(false);
    expect(existsSync(join(dir, "bin", "yt-dlp.tmp"))).toBe(false);

    const hits: string[] = [];
    const denoZip = zipOf("deno", new TextEncoder().encode("#!/bin/sh\necho deno 2.9.8\n"));
    const dAsset = denoAsset(process.platform, process.arch)!;
    const dBase = "https://github.com/denoland/deno/releases/latest/download";
    const good = createDownloaderTools({
      dataDir: dir, db, env: { PATH: "" }, exists: (p) => p.startsWith(dir) && existsSync(p),
      fetch: fakeFetch(
        {
          [`${base}/SHA2-256SUMS`]: `${sha(FAKE_YTDLP)}  ${asset}\n`,
          [`${base}/${asset}`]: FAKE_YTDLP,
          [`${dBase}/${dAsset}.sha256sum`]: `${sha(denoZip)}  ${dAsset}\n`,
          [`${dBase}/${dAsset}`]: denoZip,
        },
        hits,
      ),
    });
    await good.installMissing();
    const st = await good.status();
    expect(st.install.error).toBeNull();
    expect(st.ytdlp).toMatchObject({ source: "app", version: "2026.01.01", path: join(dir, "bin", "yt-dlp") });
    expect(st.ytdlp.checkedAt).not.toBeNull();
    expect(st.jsRuntime).toMatchObject({ kind: "deno", version: "2.9.8" });
    expect(readFileSync(join(dir, "bin", "yt-dlp"), "utf8")).toBe(FAKE_YTDLP);
    // Already there: a second install fetches nothing.
    hits.length = 0;
    await good.installMissing();
    expect(hits).toEqual([]);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("self-update: app binary only, daily, never beside a running yt-dlp, failure keeps the old binary", async () => {
  const dir = tmp();
  const db = openDb(join(dir, "t.db"), MIGRATIONS);
  try {
    let clock = Date.parse("2026-11-08T12:00:00Z");
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "yt-dlp"), FAKE_YTDLP);
    chmodSync(join(bin, "yt-dlp"), 0o755);
    const t = createDownloaderTools({ dataDir: dir, db, env: { PATH: "" }, exists: (p) => p.startsWith(dir) && existsSync(p), now: () => clock });
    expect(await t.updateYtDlpIfDue(() => true)).toBeNull();
    expect(await t.updateYtDlpIfDue()).toContain("Latest version");
    expect(getSetting(db, "ytdlp_checked_at")).toBe(new Date(clock).toISOString());
    expect(await t.updateYtDlpIfDue()).toBeNull();
    clock += 25 * 3600_000;
    expect(await t.updateYtDlpIfDue()).toContain("Latest version");

    // A yt-dlp that is not the app's is never updated.
    const other = tmp();
    try {
      writeFileSync(join(other, "yt-dlp"), FAKE_YTDLP);
      chmodSync(join(other, "yt-dlp"), 0o755);
      const t2 = createDownloaderTools({ dataDir: dir, db, env: { TUVA_BIN_DIR: other, PATH: "" }, now: () => clock + 99 * 3600_000 });
      expect(await t2.updateYtDlpIfDue()).toBeNull();
    } finally {
      rmSync(other, { recursive: true, force: true });
    }

    // `-U` fails and leaves a broken binary: the old one comes back, the check time does not move.
    const broken = "#!/bin/sh\nif [ \"$1\" = \"-U\" ]; then echo broken > \"$0\"; exit 100; fi\necho 2026.01.01\n";
    writeFileSync(join(bin, "yt-dlp"), broken);
    const before = getSetting(db, "ytdlp_checked_at");
    clock += 25 * 3600_000;
    await t.updateYtDlpIfDue();
    expect(getSetting(db, "ytdlp_checked_at")).toBe(before);
    expect(readFileSync(join(bin, "yt-dlp"), "utf8")).toContain("2026.01.01");
    expect(existsSync(join(bin, "yt-dlp.bak"))).toBe(false);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
