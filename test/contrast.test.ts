// WEB-13: `.dim` (`--fg3`) carries whole sentences and warnings ("This cannot be undone."), so it must meet WCAG AA
// for body text (4.5:1) on the page and panel backgrounds, in the base tokens and in every theme's formula.
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dir, "../src/web");
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lin = (c: number) => ((c /= 255), c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (rgb: number[]) => 0.2126 * lin(rgb[0]!) + 0.7152 * lin(rgb[1]!) + 0.0722 * lin(rgb[2]!);
const ratio = (a: number[], b: number[]) => {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
/** `color-mix(in srgb, a p%, b)`: per-channel interpolation of the encoded values. */
const mix = (a: number[], b: number[], p: number) => a.map((v, i) => v * p + b[i]! * (1 - p));

/** The custom properties of a stylesheet's first block, resolving hex values, var() and two-colour srgb color-mix(). */
function tokens(css: string): Record<string, number[]> {
  const raw: Record<string, string> = {};
  for (const m of css.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) raw[m[1]!] ??= m[2]!.trim();
  const out: Record<string, number[]> = {};
  const value = (v: string): number[] | null => {
    let m;
    if ((m = v.match(/^#[0-9a-fA-F]{6}$/))) return hex(v);
    if ((m = v.match(/^var\((--[a-z0-9-]+)\)$/))) return get(m[1]!);
    if ((m = v.match(/^color-mix\(in srgb, (.+) (\d+)%, (.+)\)$/))) {
      const a = value(m[1]!), b = value(m[3]!);
      return a && b ? mix(a, b, Number(m[2]) / 100) : null;
    }
    return null;
  };
  const get = (k: string): number[] | null => (out[k] ??= value(raw[k] ?? "")!) ?? null;
  for (const k of Object.keys(raw)) get(k);
  return out;
}

describe("--fg3 contrast (WEB-13)", () => {
  const sheets: [string, string][] = [["base (Wall)", readFileSync(join(WEB, "styles.css"), "utf8")]];
  for (const t of readdirSync(join(WEB, "themes"))) sheets.push([t, readFileSync(join(WEB, "themes", t, "theme.css"), "utf8")]);
  for (const [name, css] of sheets) {
    test(`${name}: --fg3 is at least 4.5:1 on --bg and --bg2`, () => {
      const tk = tokens(css);
      expect(tk["--fg3"]).toBeTruthy();
      expect(ratio(tk["--fg3"]!, tk["--bg"]!)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(tk["--fg3"]!, tk["--bg2"]!)).toBeGreaterThanOrEqual(4.5);
    });
  }
});
