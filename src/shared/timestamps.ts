// Timestamp-block parser (docs/research/youtube-chapter-timestamps.md section 5, issue #5) and the small time maths of
// manual Chapter editing (spec 5.3). Pure; shared by the suggest step, the Chapter cards and the tests.

export interface TimestampEntry {
  startS: number;
  title: string;
}

const TS = "(?:(\\d{1,2}):)?(\\d{1,2}):(\\d{2})";
const SEP = "[-–—|:•·~>»/]";
const LEAD = new RegExp(
  `^\\s*(?:\\d{1,2}[.)]\\s+)?[\\[(]?${TS}(?:ish)?[\\])]?(?:\\s*[-–—]\\s*[\\[(]?${TS}[\\])]?)?\\s*(?:${SEP}\\s*)?(?<title>\\S.*?)?\\s*$`,
  "u",
);
const TRAIL = new RegExp(`^\\s*(?:\\d{1,2}[.)]\\s+)?(?<title>\\S.*?)\\s*(?:${SEP}\\s*)?[\\[(]?${TS}[\\])]?\\s*$`, "u");
const INLINE = new RegExp(`[\\[(]?${TS}[\\])]?`, "gu");
const MID = new RegExp(`\\s(?:[+,;/&]\\s*)?${TS}\\s+(?=\\S)`, "gu");

/** h:mm:ss parts to seconds; null for seconds >= 60, or minutes >= 60 when an hour part is present. */
function secs(h: string | undefined, m: string | undefined, s: string | undefined): number | null {
  const hh = Number(h ?? 0);
  const mm = Number(m);
  const ss = Number(s);
  if (!Number.isFinite(mm) || !Number.isFinite(ss) || ss >= 60 || (h != null && h !== "" && mm >= 60)) return null;
  return hh * 3600 + mm * 60 + ss;
}

const STRIP = /^[\s\-–—|:•·~"'«»“”]+|[\s\-–—|:•·~"'«»“”]+$/gu;
function clean(t: string | undefined): string {
  return (t ?? "").replace(STRIP, "").replace(/^\d{1,2}[.)]\s+/, "");
}

function expand(e: TimestampEntry): TimestampEntry[] {
  const out: TimestampEntry[] = [];
  let last = 0;
  let cur = e.startS;
  for (const m of e.title.matchAll(MID)) {
    const mt = secs(m[1], m[2], m[3]);
    if (mt == null) continue;
    out.push({ startS: cur, title: clean(e.title.slice(last, m.index)) });
    cur = mt;
    last = m.index! + m[0].length;
  }
  out.push({ startS: cur, title: clean(e.title.slice(last)) });
  return out;
}

/** A list bullet or dash in front of the line ("- 0:00 Song", "• 3:10 Song") is not part of the entry. */
const BULLET = /^\s*[-–—•·*▪●◦►▶]+\s*/u;

function parseLine(raw: string): TimestampEntry | null {
  const line = raw.replace(BULLET, "");
  let m = LEAD.exec(line);
  if (m) {
    const t = secs(m[1], m[2], m[3]);
    if (t != null) return { startS: t, title: clean(m.groups!.title) };
  }
  m = TRAIL.exec(line);
  if (m) {
    const t = secs(m[2], m[3], m[4]);
    if (t != null) return { startS: t, title: clean(m.groups!.title) };
  }
  return null;
}

/**
 * The longest strictly ascending run of at least 3 entries within the Video's duration, or [].
 * `duration` null/0 means unknown: no upper bound.
 */
export function parseTimestampBlock(text: string | null | undefined, duration: number | null = null): TimestampEntry[] {
  const lines = (text ?? "").replace(/\r/g, "").split("\n");
  let entries: TimestampEntry[] = [];
  for (const l of lines) {
    const e = parseLine(l);
    if (e) entries.push(...expand(e));
  }
  if (entries.length < 3) {
    // single-line lists: "0:00 A 3:10 B 7:45 C"
    for (const l of lines) {
      const ms = [...l.matchAll(INLINE)];
      if (ms.length < 3) continue;
      const cand: TimestampEntry[] = [];
      ms.forEach((mm, i) => {
        const t = secs(mm[1], mm[2], mm[3]);
        if (t == null) return;
        cand.push({ startS: t, title: clean(l.slice(mm.index! + mm[0].length, i + 1 < ms.length ? ms[i + 1]!.index : l.length)) });
      });
      if (cand.length > entries.length) entries = cand;
    }
  }
  let run: TimestampEntry[] = [];
  let best: TimestampEntry[] = [];
  for (const e of entries) {
    if (duration && e.startS > duration) continue;
    if (run.length && e.startS <= run[run.length - 1]!.startS) {
      if (run.length > best.length) best = run;
      run = [];
    }
    run.push(e);
  }
  if (run.length > best.length) best = run;
  return best.length >= 3 ? best : [];
}

// ---- the Chapter card's time field and nudge ----

/**
 * What the card's time field accepts: `m:ss`, `h:mm:ss` or a bare number of seconds (decimals allowed). Seconds and
 * minutes below 60 where a larger unit is present. Returns null for anything else.
 */
export function parseTimeField(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2}(?:\.\d+)?)$/.exec(t);
  if (!m) return null;
  const h = m[1] != null ? Number(m[1]) : null;
  const mm = Number(m[2]);
  const ss = Number(m[3]);
  if (ss >= 60 || (h != null && mm >= 60)) return null;
  return (h ?? 0) * 3600 + mm * 60 + ss;
}

/** `m:ss` / `h:mm:ss` for the time field and the cards; sub-second starts keep a `.mmm` tail so a collision nudge is visible. */
export function formatStart(s: number): string {
  const whole = Math.floor(s + 1e-9);
  const frac = s - whole;
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const sec = whole % 60;
  const tail = frac > 0.0005 ? `.${String(Math.round(frac * 1000)).padStart(3, "0")}` : "";
  return (h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`) + tail;
}

/** Rounds to the millisecond (the unit of the UNIQUE collision nudge) and clamps to [0, duration]. */
export function clampStart(s: number, duration: number | null | undefined): number {
  let v = Math.round(s * 1000) / 1000;
  if (duration != null && Number.isFinite(duration) && duration > 0) v = Math.min(v, Math.floor(duration * 1000) / 1000);
  return Math.max(0, v);
}

/** `←` `→` on a card: start +/- 1 s, clamped. */
export function nudgeStart(s: number, delta: number, duration?: number | null): number {
  return clampStart(s + delta, duration);
}
