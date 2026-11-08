// PROTOTYPE (#193) — throwaway. A fake Download queue that lives in memory only: no yt-dlp, no server, no files.
// It exists so the dialog and card variants have something moving to render. Nothing here is the real queue's design;
// the lifecycle is #192's decision and the spec (#194) owns it.
import { useEffect, useState } from "preact/hooks";
import type { VideoDto } from "../../shared/types";
import { isNotHere, sourceLink } from "../../shared/presence";

export type Quality = "720p" | "1080p" | "best";
export type JobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface Job {
  id: string;
  title: string;
  site: string;
  url: string;
  sizeMB: number;
  doneMB: number;
  speed: number; // MB/s, displayed
  state: JobState;
  log: string[];
  reason?: string;
  attempts: number;
  failAt: number | null; // fraction at which this attempt fails, null = succeeds
}

const MB_PER_S: Record<Quality, number> = { "720p": 0.3, "1080p": 0.55, best: 1.15 };
export const DEFAULT_MBPS = 2;
export const DISK_FREE_MB = 412_000;
/** The demo runs this many times faster than the numbers it shows, so a 300 MB Video finishes in seconds. */
const DEMO_SPEEDUP = 8;

export const estMB = (v: Pick<VideoDto, "durationS">, q: Quality) => Math.round((v.durationS ?? 240) * MB_PER_S[q]);
export const estS = (mb: number) => mb / DEFAULT_MBPS;

export function fmtMB(mb: number) {
  return mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}
export function fmtDur(s: number) {
  s = Math.round(s);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// ---- prototype UI state (variant, pretend mode, dialog open) ----
type Variant = "A" | "B" | "C";
export const VARIANTS: { key: Variant; name: string }[] = [
  { key: "A", name: "Stepper" },
  { key: "B", name: "One sheet" },
  { key: "C", name: "Terminal-first" },
];
const fromUrl = new URLSearchParams(location.search).get("variant") as Variant | null;
let stored: Variant | null = null;
try {
  stored = localStorage.getItem("proto-dl-variant") as Variant | null;
} catch {}

export const proto = {
  variant: (fromUrl && VARIANTS.some((v) => v.key === fromUrl) ? fromUrl : stored && VARIANTS.some((v) => v.key === stored) ? stored : "A") as Variant,
  /** Treat every Video with a source link as Not on this machine, so a full library still has something to download. */
  pretend: false,
  open: false,
};

export function setVariant(v: Variant) {
  proto.variant = v;
  try {
    localStorage.setItem("proto-dl-variant", v);
  } catch {}
  const u = new URL(location.href);
  u.searchParams.set("variant", v);
  history.replaceState(history.state, "", u);
  notify();
}
export function setPretend(on: boolean) {
  proto.pretend = on;
  notify();
}
export function openDownloader(on = true) {
  proto.open = on;
  notify();
}

export const isCandidate = (v: VideoDto) => !!sourceLink(v) && (isNotHere(v) || proto.pretend) && sim.jobs.get(v.id)?.state !== "done";

// ---- the fake queue ----
export const sim = {
  jobs: new Map<string, Job>(),
  order: [] as string[],
  bulk: null as string[] | null, // the latest bulk job's Videos (the dialog's log step)
  lines: [] as string[], // the bulk job's merged terminal
  paused: false,
  failNext: false,
};

const subs = new Set<() => void>();
function notify() {
  for (const f of subs) f();
}
export function useSim() {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((n) => n + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  return sim;
}

function push(job: Job, line: string, replaceProgress = false) {
  if (replaceProgress && job.log.length && job.log[job.log.length - 1]!.startsWith("[download]  ")) job.log[job.log.length - 1] = line;
  else job.log.push(line);
  if (sim.bulk?.includes(job.id)) {
    const tag = `‹${job.title.length > 22 ? job.title.slice(0, 21) + "…" : job.title}›`;
    if (replaceProgress && sim.lines.length && sim.lines[sim.lines.length - 1]!.startsWith(`[download]  `) && sim.lines[sim.lines.length - 1]!.endsWith(tag)) sim.lines[sim.lines.length - 1] = `${line}  ${tag}`;
    else sim.lines.push(replaceProgress ? `${line}  ${tag}` : line);
    if (sim.lines.length > 800) sim.lines.splice(0, sim.lines.length - 800);
  }
}

function makeJob(v: VideoDto, q: Quality): Job {
  const link = sourceLink(v)!;
  const h = hash(v.id);
  return {
    id: v.id,
    title: v.title,
    site: link.site,
    url: link.href,
    sizeMB: estMB(v, q),
    doneMB: 0,
    speed: 1.4 + (h % 30) / 10,
    state: "queued",
    log: [],
    attempts: 0,
    failAt: h % 6 === 0 ? 0.15 + (h % 50) / 100 : null,
  };
}

/** Add Videos to the queue; a card click goes to the front. */
export function enqueue(videos: VideoDto[], q: Quality, front: boolean) {
  for (const v of videos) {
    let j = sim.jobs.get(v.id);
    if (!j || j.state === "cancelled" || j.state === "failed") {
      j = makeJob(v, q);
      sim.jobs.set(v.id, j);
    }
    sim.order = sim.order.filter((id) => id !== v.id);
    if (front) sim.order.unshift(v.id);
    else sim.order.push(v.id);
  }
  notify();
}

export function startBulk(videos: VideoDto[], q: Quality) {
  sim.bulk = videos.map((v) => v.id);
  sim.lines = [`$ yt-dlp (2 at a time, ${q === "best" ? "best quality" : `≤ ${q}`}) — ${videos.length} Videos`];
  enqueue(videos, q, false);
}

export function retryFailed(ids: string[]) {
  for (const id of ids) {
    const j = sim.jobs.get(id);
    if (!j || j.state !== "failed") continue;
    j.state = "queued";
    j.failAt = null; // the retry works in the demo
    j.reason = undefined;
    push(j, `--- retry ${j.title}`);
    sim.order = sim.order.filter((x) => x !== id);
    sim.order.push(id);
  }
  notify();
}

export function cancelAll() {
  for (const id of sim.bulk ?? []) {
    const j = sim.jobs.get(id);
    if (j && (j.state === "queued" || j.state === "running")) j.state = "cancelled";
  }
  sim.lines.push("^C cancelled: the .part files stay and a later run continues them");
  notify();
}
export function togglePause() {
  sim.paused = !sim.paused;
  sim.lines.push(sim.paused ? "‖ paused" : "▶ resumed");
  notify();
}

function begin(j: Job) {
  j.state = "running";
  if (sim.failNext) (j.failAt = 0.3), (sim.failNext = false);
  j.attempts++;
  const id = j.url.split(/[=/]/).filter(Boolean).pop();
  const ex = j.site === "YouTube" ? "youtube" : j.site;
  push(j, `[${ex}] Extracting URL: ${j.url}`);
  push(j, `[${ex}] ${id}: Downloading webpage`);
  if (j.site === "YouTube") push(j, `[youtube] ${id}: Downloading tv client config`);
  push(j, `[info] ${id}: Downloading 1 format(s): 137+140`);
  push(j, `[download] Destination: ${j.title} [${id}].f137.mp4`);
}

function fail(j: Job) {
  j.state = "failed";
  const id = j.url.split(/[=/]/).filter(Boolean).pop();
  if (j.site === "Instagram") {
    j.reason = "Login wall or removed post";
    push(j, `ERROR: [Instagram] ${id}: Requested content is not available, rate-limit reached or login required. Use --cookies, --cookies-from-browser, --username and --password, --netrc-cmd, or --netrc (instagram) to provide account credentials`);
  } else if (hash(j.id) % 2) {
    j.reason = "Unavailable (removed by the uploader)";
    push(j, `ERROR: [youtube] ${id}: Video unavailable. This video has been removed by the uploader`);
  } else {
    j.reason = "Private video";
    push(j, `ERROR: [youtube] ${id}: Private video. Sign in if you've been granted access to this video`);
  }
}

setInterval(() => {
  if (sim.paused) return;
  let changed = false;
  let running = sim.order.map((id) => sim.jobs.get(id)!).filter((j) => j?.state === "running");
  for (const id of sim.order) {
    if (running.length >= 2) break;
    const j = sim.jobs.get(id);
    if (j?.state === "queued") {
      begin(j);
      running.push(j);
      changed = true;
    }
  }
  for (const j of running) {
    j.speed = Math.min(6, Math.max(0.6, j.speed + (Math.random() - 0.5) * 0.6));
    j.doneMB = Math.min(j.sizeMB, j.doneMB + j.speed * 0.25 * DEMO_SPEEDUP);
    const pct = (j.doneMB / j.sizeMB) * 100;
    const eta = Math.max(0, (j.sizeMB - j.doneMB) / j.speed);
    push(j, `[download]  ${pct.toFixed(1).padStart(5)}% of ${(j.sizeMB / 1.048576).toFixed(2).padStart(8)}MiB at ${j.speed.toFixed(2).padStart(6)}MiB/s ETA ${String(Math.floor(eta / 60)).padStart(2, "0")}:${String(Math.round(eta % 60)).padStart(2, "0")}`, true);
    if (j.failAt != null && j.doneMB / j.sizeMB >= j.failAt) fail(j);
    else if (j.doneMB >= j.sizeMB) {
      push(j, `[Merger] Merging formats into "${j.title}.mp4"`);
      push(j, `Deleting original file ${j.title}.f137.mp4 (pass -k to keep)`);
      push(j, `✓ scanned: ${j.title} is on this machine`);
      j.state = "done";
    }
    changed = true;
  }
  if (changed) notify();
}, 250);

export function bulkJobs(): Job[] {
  return (sim.bulk ?? []).map((id) => sim.jobs.get(id)!).filter(Boolean);
}

export function bulkTotals() {
  const jobs = bulkJobs();
  const size = jobs.reduce((a, j) => a + j.sizeMB, 0);
  const done = jobs.reduce((a, j) => a + (j.state === "done" ? j.sizeMB : j.doneMB), 0);
  const count = (s: JobState) => jobs.filter((j) => j.state === s).length;
  const running = jobs.filter((j) => j.state === "running");
  const speed = running.reduce((a, j) => a + j.speed, 0) || DEFAULT_MBPS;
  return { jobs, size, done, pct: size ? (done / size) * 100 : 0, nDone: count("done"), nFailed: count("failed"), nLeft: count("queued") + count("running"), nCancelled: count("cancelled"), etaS: (size - done) / speed, speed };
}

export function failureReport(): string {
  const failed = bulkJobs().filter((j) => j.state === "failed");
  return ["TuvaVideos — Failure report", new Date().toLocaleString(), "", ...failed.map((j) => `${j.title}\n  ${j.url}\n  ${j.reason}`)].join("\n");
}
export function saveFailureReport() {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([failureReport()], { type: "text/plain" }));
  a.download = "TuvaVideos failure report.txt";
  a.click();
}

/** Poke at the fake queue from the console: `__dlsim.failNext = true` makes the next started Video fail. */
(window as unknown as { __dlsim: unknown }).__dlsim = sim;
