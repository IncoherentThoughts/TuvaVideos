// Instagram sign-in for the Downloader (docs/downloader-spec.md §5.2–5.3): the `instagram_auth` setting, the one-time
// notice, the copied cookies.txt, and what the runner asks of them (§5.4). `GET/PUT /api/downloads/settings` (§6).
// The cookies themselves never leave this module: no reply carries a cookie file's contents or its original path.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db";
import type { Cookies } from "./args";
import { getSetting, setSetting } from "./toolsInstall";

export const BROWSERS = ["firefox", "safari", "chrome", "brave", "edge", "chromium", "opera", "vivaldi"] as const;
export type Browser = (typeof BROWSERS)[number];

export type InstagramAuth =
  | { kind: "none" }
  | { kind: "browser"; browser: Browser; lastWorkedAt?: string; expired?: boolean }
  | { kind: "file"; lastWorkedAt?: string; expired?: boolean };

export interface DownloadSettings {
  instagramAuth: InstagramAuth;
  /** When the §5.3 notice was acknowledged; null until then (cookies cannot be set before). */
  noticeAckAt: string | null;
  browsers: readonly Browser[];
  /** For the picker's macOS notes (keychain prompt, Full Disk Access). */
  platform: string;
}

export const COOKIES_FILE = "instagram-cookies.txt";
export const NOT_NETSCAPE = "Not a Netscape cookies.txt";
const HEADER = /^# (Netscape )?HTTP Cookie File\s*$/;

export const cookiesPath = (dataDir: string) => join(dataDir, COOKIES_FILE);

/** §5.2: the first line must be `# HTTP Cookie File` or `# Netscape HTTP Cookie File` (a BOM is tolerated). */
export function isNetscapeCookies(text: string): boolean {
  const first = text.replace(/^﻿/, "").split(/\r?\n/, 1)[0] ?? "";
  return HEADER.test(first);
}

export function readAuth(db: Db): InstagramAuth {
  try {
    const a = JSON.parse(getSetting(db, "instagram_auth") ?? "null") as InstagramAuth | null;
    if (a && a.kind === "browser" && (BROWSERS as readonly string[]).includes(a.browser)) return a;
    if (a && a.kind === "file") return a;
  } catch {
    /* unreadable: signed out */
  }
  return { kind: "none" };
}

function writeAuth(db: Db, a: InstagramAuth) {
  setSetting(db, "instagram_auth", JSON.stringify(a));
}

export function getSettings(db: Db): DownloadSettings {
  return { instagramAuth: readAuth(db), noticeAckAt: getSetting(db, "instagram_notice_ack_at"), browsers: BROWSERS, platform: process.platform };
}

export class SettingsError extends Error {}

/**
 * `PUT /api/downloads/settings` body: `{ noticeAck?: true, instagramAuth?: { kind: "none" } | { kind: "browser", browser }
 * | { kind: "file", path } }`. `path` is a file on this machine (from `/api/choose-file`); it is checked, copied to
 * `<dataDir>/instagram-cookies.txt` at 0600 and forgotten. Any new setting starts without `lastWorkedAt` / `expired`.
 * Throws SettingsError (→ 400) and changes nothing when the body is refused.
 */
export function putSettings(db: Db, dataDir: string, body: Record<string, unknown>, now = () => new Date()): DownloadSettings {
  const ack = body.noticeAck;
  if (ack !== undefined && ack !== true) throw new SettingsError("noticeAck must be true");
  const want = body.instagramAuth;
  let next: InstagramAuth | null = null;
  let copy: Buffer | null = null;
  if (want !== undefined) {
    if (!want || typeof want !== "object" || Array.isArray(want)) throw new SettingsError("instagramAuth must be an object");
    const w = want as Record<string, unknown>;
    if (w.kind === "none") next = { kind: "none" };
    else if (w.kind === "browser" || w.kind === "file") {
      // §5.3: setting cookies without acknowledging the notice is not possible (the ack may come in the same request).
      if (ack !== true && !getSetting(db, "instagram_notice_ack_at")) throw new SettingsError("acknowledge the Instagram notice first");
      if (w.kind === "browser") {
        if (typeof w.browser !== "string" || !(BROWSERS as readonly string[]).includes(w.browser)) throw new SettingsError(`browser must be one of ${BROWSERS.join(", ")}`);
        next = { kind: "browser", browser: w.browser as Browser };
      } else {
        if (typeof w.path !== "string" || !w.path.startsWith("/")) throw new SettingsError("path must be an absolute path to a cookies.txt");
        copy = readCookiesFile(w.path);
        next = { kind: "file" };
      }
    } else throw new SettingsError("instagramAuth.kind must be none, browser or file");
  }

  if (ack === true && !getSetting(db, "instagram_notice_ack_at")) setSetting(db, "instagram_notice_ack_at", now().toISOString());
  if (next) {
    const dest = cookiesPath(dataDir);
    if (copy) {
      mkdirSync(dataDir, { recursive: true });
      // Replace, never write through an existing file's (possibly wider) mode.
      rmSync(dest, { force: true });
      writeFileSync(dest, copy, { mode: 0o600 });
      chmodSync(dest, 0o600);
    } else rmSync(dest, { force: true }); // §5.2: clearing (or switching to a browser) deletes the copied file
    writeAuth(db, next);
  }
  return getSettings(db);
}

function readCookiesFile(path: string): Buffer {
  let buf: Buffer;
  try {
    buf = readFileSync(path);
  } catch (e) {
    throw new SettingsError(`cannot read the file: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  // Only the first line is looked at; a cookies.txt is small, but cap what gets copied anyway.
  if (buf.length > 4 * 1024 * 1024 || !isNetscapeCookies(buf.subarray(0, 256).toString("utf8"))) throw new SettingsError(NOT_NETSCAPE);
  return buf;
}

/** What the runner passes yt-dlp for the cookies retry (§5.4): null when signed out, expired, or the file has gone. */
export function cookiesFor(db: Db, dataDir: string): Cookies | null {
  const a = readAuth(db);
  if (a.kind === "none" || a.expired) return null;
  if (a.kind === "browser") return { browser: a.browser };
  const f = cookiesPath(dataDir);
  return existsSync(f) ? { file: f } : null;
}

/** The cookies retry's outcome (§5.4): success sets `lastWorkedAt` (and clears `expired`); `cookies_expired` sets `expired`. */
export function noteCookies(db: Db, outcome: "worked" | "expired", now = () => new Date()) {
  const a = readAuth(db);
  if (a.kind === "none") return;
  if (outcome === "worked") writeAuth(db, { ...a, lastWorkedAt: now().toISOString(), expired: undefined });
  else writeAuth(db, { ...a, expired: true });
}

