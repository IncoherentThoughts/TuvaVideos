// Screenshots (spec 4.5): the browser draws the current frame, the server writes `<title> @ <seconds>s.png`
// to the screenshot folder (`~/Desktop`; not settable in v1, the env var exists for tests and the smoke run).
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const MAX_SCREENSHOT_BYTES = 64 * 1024 * 1024;

export const isPng = (b: Uint8Array) => b.length > 8 && PNG_SIGNATURE.every((x, i) => b[i] === x);

const MAX_TITLE_BYTES = 150; // leaves room for " @ 12345.67s.png" under the 255-byte name limit

/** Characters a macOS or portable filename cannot or should not carry. */
export function sanitizeTitle(title: string): string {
  let s = title
    .normalize("NFC")
    .replace(/[\t\n\r]/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/[\/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "") // no hidden files, no ".."
    .trim();
  const enc = new TextEncoder();
  while (enc.encode(s).length > MAX_TITLE_BYTES) s = [...s].slice(0, -1).join("");
  return s.trim() || "screenshot";
}

/** 12 -> "12", 12.3 -> "12.3", 12.345 -> "12.35": at most two decimals, no trailing zeros. */
export function fmtSeconds(t: number): string {
  const r = Math.round(Math.max(0, t) * 100) / 100;
  return String(r);
}

export const screenshotName = (title: string, t: number) => `${sanitizeTitle(title)} @ ${fmtSeconds(t)}s.png`;

/** Writes the PNG and returns the absolute path. Overwrites a screenshot of the same title and time. */
export async function saveScreenshot(dir: string, title: string, t: number, png: Uint8Array): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, screenshotName(title, t));
  await writeFile(path, png);
  return path;
}
