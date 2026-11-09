// The download dialog's pure parts (docs/downloader-spec.md §7): number words, the footer's disabled rules, the log's
// row order and marks, the pace colour, the status that replaces the speed, and the yt-dlp output's colouring. No DOM,
// no fetch: `test/downloadDialog.test.ts` covers it.
import { DISK_MARGIN, totalsOf, type EstimateTotals } from "../../shared/downloadEstimate";
import type { ItemState } from "../../server/downloads/queue";

// ---- words ---------------------------------------------------------------------------------------------------------

/** Decimal units, like the Finder: "820 MB", "4.2 GB", "41 GB". */
export function fmtBytes(b: number): string {
  if (!Number.isFinite(b) || b <= 0) return "0 MB";
  if (b < 1e6) return `${Math.max(1, Math.round(b / 1e3))} KB`;
  if (b < 1e9) return `${Math.round(b / 1e6)} MB`;
  return b < 10e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round(b / 1e9)} GB`;
}

/** A duration for estimates: "40 s", "12 min", "1 h 20 min", "5 h", "2 d 3 h". */
export function fmtDur(s: number): string {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h >= 48) return `${Math.floor(h / 24)} d${h % 24 ? ` ${h % 24} h` : ""}`;
  if (h >= 10) return `${Math.round(m / 60)} h`;
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** A Video's length in the picker: "3:07", "1:02:05"; "–" without one. */
export function fmtLen(s: number | null | undefined): string {
  if (s == null || !Number.isFinite(s)) return "–";
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const mm = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(mm).padStart(2, "0")}:${ss}` : `${mm}:${ss}`;
}

export const fmtSpeed = (bps: number) => `${(bps / 1e6).toFixed(1)} MB/s`;
export const videos = (n: number) => `${n} Video${n === 1 ? "" : "s"}`;

/** A tile's second line, size then time with no dot between them (§7.2): "≈ 41 GB 5 h". */
export function tileLine(t: Pick<EstimateTotals, "count" | "estBytes" | "estSeconds">): { size: string; time: string } {
  if (!t.count) return { size: "nothing", time: "" };
  return { size: `≈ ${fmtBytes(t.estBytes)}`, time: t.estSeconds ? `~${fmtDur(t.estSeconds)}` : "" };
}

/** The primary button: "Download 12 Videos (≈ 4.2 GB) ~35 min". */
export function confirmLabel(t: Pick<EstimateTotals, "count" | "estBytes" | "estSeconds">): string {
  if (!t.count) return "Download";
  const size = t.estBytes > 0 ? ` (≈ ${fmtBytes(t.estBytes)})` : "";
  const time = t.estSeconds > 0 ? ` ~${fmtDur(t.estSeconds)}` : "";
  return `Download ${videos(t.count)}${size}${time}`;
}

// ---- choosing (§7.2) -----------------------------------------------------------------------------------------------

export interface PickVideo {
  id: string;
  estBytes: number | null;
}

/** What the picker's checkboxes leave: every Video of the option but the unchecked ones, with their totals. */
export function picked<V extends PickVideo>(list: readonly V[], excluded: ReadonlySet<string>, throughputBps: number): { videos: V[]; totals: EstimateTotals } {
  const videos = list.filter((v) => !excluded.has(v.id));
  return { videos, totals: totalsOf(videos.map((v) => v.estBytes), throughputBps) };
}

/** The Select all box: on when everything is picked, mixed when some are, off when none are. */
export function selectAllState(total: number, excludedCount: number): "all" | "some" | "none" {
  if (total === 0 || excludedCount >= total) return "none";
  return excludedCount === 0 ? "all" : "some";
}

export interface FooterInput {
  count: number;
  estBytes: number;
  /** null: the volume could not be read, and the dialog then does not block (§6). */
  freeBytes: number | null;
  destDir: string | null;
  /** yt-dlp is missing and not installed yet (§2.5). */
  toolsMissing: boolean;
  busy: boolean;
}

/** Why the primary button is disabled (§7.2, §3.4), or null when it can be pressed. */
export function confirmBlock(f: FooterInput): string | null {
  if (f.busy) return "working…";
  if (!f.destDir) return "no Root is mounted: choose a folder";
  if (f.toolsMissing) return "install yt-dlp first";
  if (f.count === 0) return "nothing picked";
  if (f.freeBytes != null && f.estBytes * DISK_MARGIN > f.freeBytes) return "not enough free space";
  return null;
}

// ---- the log (§7.3) ------------------------------------------------------------------------------------------------

export type RowGroup = "running" | "failed" | "queued" | "done" | "cancelled";

/** Which of the log's four groups a state sorts into: running → failed → queued → done (cancelled last). */
export function rowGroup(s: ItemState): RowGroup {
  switch (s) {
    case "sizing":
    case "downloading":
    case "merging":
    case "scanning":
      return "running";
    case "failed":
      return "failed";
    case "queued":
    case "waiting":
      return "queued";
    case "cancelled":
      return "cancelled";
    default:
      return "done"; // done, done_outside, skipped
  }
}
const GROUP_RANK: Record<RowGroup, number> = { running: 0, failed: 1, queued: 2, done: 3, cancelled: 4 };
export const ROW_MARK: Record<RowGroup, string> = { running: "↓", failed: "!", queued: "", done: "✓", cancelled: "" };
export const isLive = (s: ItemState) => rowGroup(s) === "running" || rowGroup(s) === "queued";

/** The log's rows: by group, then in queue order. Stable; does not touch its input. */
export function sortRows<T extends { state: ItemState; queuePos: number; id: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => GROUP_RANK[rowGroup(a.state)] - GROUP_RANK[rowGroup(b.state)] || a.queuePos - b.queuePos || a.id - b.id);
}

export type Pace = "slow" | "mid" | "fast";
/** The speed's colour (§7.3): red under 1.5 MB/s, yellow under 4 MB/s, green from 4 MB/s. */
export const paceOf = (bps: number): Pace => (bps < 1.5e6 ? "slow" : bps < 4e6 ? "mid" : "fast");

const SITE_NAME: Record<string, string> = { youtube: "YouTube", instagram: "Instagram", rutube: "Rutube" };

export interface StatusInput {
  paused: boolean;
  offline: { since: string; nextProbeAt: string } | null;
  diskFull: { dir: string } | null;
  sitePauses: { site: string; until: string }[];
}

/** What replaces the speed when the queue is held (§7.3, §4.5), or null when it is not. */
export function heldStatus(s: StatusInput, nowMs: number): string | null {
  if (s.diskFull) return `Disk full: free space on ${s.diskFull.dir || "the volume"} and press Resume`;
  if (s.paused) return "Paused";
  if (s.offline) return "Waiting for connection…";
  const site = s.sitePauses.find((p) => Date.parse(p.until) > nowMs);
  if (site) {
    const min = Math.max(1, Math.ceil((Date.parse(site.until) - nowMs) / 60_000));
    return `${SITE_NAME[site.site] ?? site.site} paused for ${min} min (rate limit)`;
  }
  return null;
}

export interface JobCounts {
  total: number;
  done: number;
  failed: number;
  cancelled: number;
  skipped: number;
}
/** The headline: "7 of 12 downloaded", the failed count, and the percent by bytes (by count when nothing is sized). */
export function headline(c: JobCounts, doneBytes: number, totalBytes: number): { pct: number; done: number; of: number; failed: number } {
  const of = c.total - c.cancelled;
  const done = c.done + c.skipped;
  const pct = totalBytes > 0 ? (doneBytes / totalBytes) * 100 : of > 0 ? (done / of) * 100 : 0;
  return { pct: Math.max(0, Math.min(100, done === of && of > 0 ? 100 : pct)), done, of, failed: c.failed };
}

// ---- yt-dlp output (§7.3) ------------------------------------------------------------------------------------------

/** Our machine lines (§4.3 TUVA / TUVAPP / TUVAFILE) back into the words yt-dlp would print; others unchanged. */
export function displayLine(raw: string): string {
  const text = raw.startsWith("[err] ") ? raw.slice(6) : raw;
  if (text.startsWith("TUVAFILE ")) return `[file] ${text.slice(9).trim()}`;
  if (text.startsWith("TUVAPP ")) return `[postprocess] ${text.slice(7).trim()}`;
  if (text.startsWith("TUVA ")) {
    const [status, dl, total, est, speed, eta] = text.slice(5).trim().split(/\s+/);
    const n = (s: string | undefined) => (s && s !== "NA" && s !== "None" && Number.isFinite(Number(s)) ? Number(s) : null);
    const size = n(total) ?? n(est);
    const pct = size && n(dl) != null ? `${((n(dl)! / size) * 100).toFixed(1)}%` : "?%";
    const mib = (b: number | null) => (b == null ? "?" : b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)}GiB` : `${(b / 1024 ** 2).toFixed(2)}MiB`);
    const e = n(eta);
    const etaS = e == null ? "Unknown" : `${String(Math.floor(e / 60)).padStart(2, "0")}:${String(Math.round(e % 60)).padStart(2, "0")}`;
    if (status === "finished") return `[download] 100% of ${n(total) == null && n(est) != null ? "~" : ""}${mib(size)}`;
    const sp = n(speed);
    return `[download] ${pct.padStart(6)} of ${n(total) == null && n(est) != null ? "~" : ""}${mib(size)} at ${sp == null ? "Unknown B/s" : `${mib(sp)}/s`} ETA ${etaS}`;
  }
  return text;
}

export const isErrorLine = (raw: string) => /^(\[err\] )?ERROR:/.test(raw);

export type Tone = "err" | "warn" | "pct" | "speed" | "eta" | "tag" | "size" | "dim" | null;
export interface Span {
  tone: Tone;
  text: string;
}

/** One displayed line in yt-dlp `--color`'s tones: ERROR red, WARNING yellow, percent blue, speed green, ETA yellow,
 *  `[tags]` cyan. The spans' texts join back to the line. */
export function colorLine(line: string): Span[] {
  const err = /^ERROR:/.exec(line);
  if (err) return [{ tone: "err", text: line }];
  if (line.startsWith("WARNING:")) return [{ tone: "warn", text: "WARNING:" }, { tone: null, text: line.slice(8) }];
  const out: Span[] = [];
  let rest = line;
  const tag = /^\[[^\]]+\]/.exec(rest);
  if (tag) {
    out.push({ tone: "tag", text: tag[0] });
    rest = rest.slice(tag[0].length);
  }
  const pm = /^(\s+)(\S+%)( of\s+)(~?\S+)(?:( at\s+)(\S+)( ETA )(\S+))?(.*)$/.exec(rest);
  if (tag?.[0] === "[download]" && pm) {
    out.push({ tone: null, text: pm[1]! }, { tone: "pct", text: pm[2]! }, { tone: null, text: pm[3]! }, { tone: "size", text: pm[4]! });
    if (pm[5] !== undefined) out.push({ tone: null, text: pm[5] }, { tone: "speed", text: pm[6]! }, { tone: null, text: pm[7]! }, { tone: "eta", text: pm[8]! });
    if (pm[9]) out.push({ tone: null, text: pm[9] });
    return out;
  }
  if (rest) out.push({ tone: null, text: rest });
  return out;
}

// ---- the quit question (§4.7) --------------------------------------------------------------------------------------

export const quitQuestion = (n: number) => `${n} download${n === 1 ? " is" : "s are"} running. Quit anyway? They will resume next time.`;

/** The resume bar's words (§4.7). */
export function resumeLine(p: { left: number; estBytes: number; waitingForRoot: string | null }): string {
  const size = p.estBytes > 0 ? ` (≈ ${fmtBytes(p.estBytes)})` : "";
  return `Download job: ${videos(p.left)} left${size}${p.waitingForRoot ? ` — waiting for ${p.waitingForRoot}` : ""}`;
}

/** "Download videos…" shows when any Video with a source id is Not on this machine (§7). */
export function anyDownloadable(list: readonly { youtubeId: string | null; instagramId: string | null; rutubeId: string | null; available: boolean; copies: { missing: boolean }[] }[] | null): boolean {
  return !!list?.some((v) => (v.youtubeId || v.instagramId || v.rutubeId) && !v.available && v.copies.every((c) => c.missing));
}
