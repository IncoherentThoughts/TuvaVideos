// The download dialog's client state (docs/downloader-spec.md §6, §7): whether it is open and on which job, the queue
// snapshot polled every second while it is open, the job's yt-dlp output pulled by cursor, the tool status, and the
// chooser's controls (kept here, so closing the dialog loses nothing). One module-level store, like data.ts.
import { useEffect, useState } from "preact/hooks";
import type { DownloadQueue } from "../../server/downloads/queue";
import type { PlanOption, PlanResponse } from "../../server/downloadPlan";
import type { ToolStatus } from "../../server/downloads/toolsInstall";
import type { DownloadSettings, InstagramAuth } from "../../server/downloads/instagramAuth";
import type { Quality } from "../../shared/downloadEstimate";
import type { VideoType } from "../../shared/filters";
import { quitQuestion } from "./model";

export type Snapshot = ReturnType<DownloadQueue["snapshot"]>;
export type JobDto = NonNullable<Snapshot["job"]>;
export type ItemDto = Snapshot["items"][number];

/** The job's output as the dialog keeps it: at most this many lines, the oldest dropped. */
const KEEP_LINES = 5000;

export interface Choice {
  option: PlanOption;
  n: number;
  seed: number | null;
  type: VideoType | null;
  artistId: string | null;
  quality: Quality;
  /** null: the default, the first mounted Root (§7.2). */
  destDir: string | null;
  excluded: Set<string>;
}

interface State {
  open: boolean;
  view: "choose" | "log";
  /** The job the log shows; null = the server's pick (a live bulk job, else the latest). */
  jobId: number | null;
  snap: Snapshot | null;
  lines: string[];
  errors: number;
  cursor: number;
  tools: ToolStatus | null;
  plan: PlanResponse | null;
  planError: string | null;
  choice: Choice;
  /** Instagram sign-in and the notice (§5.2–5.3); never holds cookie contents (the server never sends them). */
  settings: DownloadSettings | null;
  /** The Instagram row's chooser is open ("Change…"). */
  igEditing: boolean;
  igError: string | null;
}

const st: State = {
  open: false,
  view: "choose",
  jobId: null,
  snap: null,
  lines: [],
  errors: 0,
  cursor: 0,
  tools: null,
  plan: null,
  planError: null,
  choice: { option: "full", n: 20, seed: null, type: null, artistId: null, quality: "1080p", destDir: null, excluded: new Set() },
  settings: null,
  igEditing: false,
  igError: null,
};
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

export function useDownloads(): State {
  const [, set] = useState(0);
  useEffect(() => {
    const f = () => set((x) => x + 1);
    subs.add(f);
    return () => void subs.delete(f);
  }, []);
  return st;
}
export const downloadsState = () => st;

// ---- HTTP ----------------------------------------------------------------------------------------------------------

async function call<T>(method: "GET" | "POST" | "PUT", url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let j: unknown = null;
  try {
    j = JSON.parse(text);
  } catch {}
  if (!r.ok) throw new Error((j as { error?: string } | null)?.error ?? `${r.status} ${text}`);
  return j as T;
}

// ---- polling (§6: 1 s while the dialog is open) --------------------------------------------------------------------

let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;

/** One snapshot: the selected job, its new log lines since the cursor. */
export function refresh(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const q = new URLSearchParams({ logCursor: String(st.cursor) });
      if (st.jobId != null) q.set("job", String(st.jobId));
      const s = await call<Snapshot>("GET", `/api/downloads?${q}`);
      // The server chose another job (ours was deleted, or none was asked for): start its output from the top.
      // (Its lines came for our old cursor, so they are dropped; the next tick reads them from 0.)
      if (st.snap?.job?.id !== s.job?.id && st.cursor !== 0) {
        st.cursor = 0;
        st.lines = [];
        st.errors = 0;
        st.snap = s;
        return;
      }
      if (s.log.reset) {
        st.lines = [];
        st.errors = 0;
      }
      for (const l of s.log.lines) {
        st.lines.push(l.text);
        if (/^(\[err\] )?ERROR:/.test(l.text)) st.errors++;
      }
      if (st.lines.length > KEEP_LINES) st.lines.splice(0, st.lines.length - KEEP_LINES);
      st.cursor = s.log.cursor;
      st.snap = s;
    } catch {
      /* the next tick tries again */
    } finally {
      inFlight = null;
    }
    emit();
  })();
  return inFlight;
}

function loop() {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!st.open) return;
  void Promise.all([refresh(), st.tools?.install.running ? loadTools() : null]).then(() => {
    if (st.open) timer = setTimeout(loop, 1000);
  });
}

export async function loadTools() {
  try {
    st.tools = await call<ToolStatus>("GET", "/api/downloads/tools");
  } catch {}
  emit();
}

export async function installTools() {
  try {
    st.tools = await call<ToolStatus>("POST", "/api/downloads/tools/install");
  } catch (e) {
    alert(`Could not start the install: ${(e as Error).message}`);
  }
  emit();
}

function selectJob(jobId: number | null) {
  if (st.jobId === jobId && st.snap) return;
  st.jobId = jobId;
  st.cursor = 0;
  st.lines = [];
  st.errors = 0;
}

/** Avatar menu → Download videos…: the chooser, or the log while a bulk job is still running (closing lost nothing). */
export async function openDownloads() {
  st.open = true;
  emit();
  await refresh();
  const live = st.snap?.jobs.find((j) => j.kind === "bulk" && j.running);
  if (live) {
    selectJob(live.id);
    st.view = "log";
  } else st.view = "choose";
  void loadTools();
  void loadSettings();
  if (st.view === "choose") void loadPlan();
  loop();
}

/** Avatar menu → Last download…: the kept bulk job's log (§4.8). */
export function openLastDownload(jobId: number) {
  selectJob(jobId);
  st.view = "log";
  st.open = true;
  void loadTools();
  loop();
  emit();
}

export function closeDownloads() {
  st.open = false;
  if (timer) clearTimeout(timer);
  timer = null;
  emit();
}

export function newDownload() {
  st.view = "choose";
  st.choice.excluded = new Set();
  emit();
  void loadPlan();
}

// ---- the plan (§6 POST /api/downloads/plan) ------------------------------------------------------------------------

let planSeq = 0;
let planTimer: ReturnType<typeof setTimeout> | null = null;

export function loadPlan(delayMs = 0) {
  if (planTimer) clearTimeout(planTimer);
  planTimer = setTimeout(() => void fetchPlan(), delayMs);
}

async function fetchPlan() {
  const c = st.choice;
  const seq = ++planSeq;
  const body: Record<string, unknown> = { option: c.option, quality: c.quality, n: c.n };
  if (c.seed != null) body.seed = c.seed;
  if (c.type) body.type = c.type;
  if (c.artistId) body.artistId = c.artistId;
  if (c.destDir) body.destDir = c.destDir;
  try {
    const p = await call<PlanResponse>("POST", "/api/downloads/plan", body);
    if (seq !== planSeq) return;
    st.plan = p;
    st.planError = null;
    // The plan resolved the defaults; keep them so the next request (and the Confirm) agree with what is shown.
    c.seed = p.seed;
    c.type = p.type;
    c.artistId = p.artistId;
  } catch (e) {
    if (seq !== planSeq) return;
    st.planError = (e as Error).message;
  }
  emit();
}

/** Changes the chooser's controls; anything but the destination or quality resets the unchecked Videos. */
export function choose(patch: Partial<Omit<Choice, "excluded">>, delayMs = 0) {
  const keepPicks = Object.keys(patch).every((k) => k === "quality" || k === "destDir");
  Object.assign(st.choice, patch);
  if (!keepPicks) st.choice.excluded = new Set();
  emit();
  loadPlan(delayMs);
}

export function toggleVideo(id: string) {
  const s = new Set(st.choice.excluded);
  s.has(id) ? s.delete(id) : s.add(id);
  st.choice.excluded = s;
  emit();
}
export function setExcluded(ids: Iterable<string>) {
  st.choice.excluded = new Set(ids);
  emit();
}

export async function chooseFolder(): Promise<void> {
  try {
    const r = await call<{ path?: string; cancelled?: boolean; error?: string }>("POST", "/api/choose-folder", { start: st.choice.destDir ?? st.plan?.destDir ?? undefined });
    if (r.path) choose({ destDir: r.path });
    else if (r.error) alert(r.error);
  } catch (e) {
    // 501 off macOS: the path field (§6)
    const typed = prompt("Download into which folder? (an absolute path)", st.choice.destDir ?? st.plan?.destDir ?? "");
    if (typed && typed.startsWith("/")) choose({ destDir: typed.replace(/(.)\/+$/, "$1") });
    else if (typed) alert(`Not an absolute path. (${(e as Error).message})`);
  }
}

// ---- the Instagram row (§5.2–5.3, GET/PUT /api/downloads/settings) ------------------------------------------------

export async function loadSettings() {
  try {
    st.settings = await call<DownloadSettings>("GET", "/api/downloads/settings");
  } catch {}
  emit();
}

export function editInstagram(on: boolean) {
  st.igEditing = on;
  st.igError = null;
  emit();
}

async function putSettings(body: { noticeAck?: true; instagramAuth?: { kind: "none" } | { kind: "browser"; browser: string } | { kind: "file"; path: string } }): Promise<boolean> {
  try {
    st.settings = await call<DownloadSettings>("PUT", "/api/downloads/settings", body);
    st.igError = null;
    return true;
  } catch (e) {
    st.igError = (e as Error).message;
    return false;
  } finally {
    emit();
  }
}

/** §5.3: the notice's "I understand". */
export const acknowledgeInstagramNotice = () => putSettings({ noticeAck: true });

export async function setInstagramAuth(a: Exclude<InstagramAuth, { kind: "file" }>) {
  if (await putSettings({ instagramAuth: a.kind === "none" ? { kind: "none" } : { kind: "browser", browser: a.browser } })) editInstagram(false);
}

/** The Finder's file chooser (`/api/choose-file`), else a typed path; the server checks and copies it (§5.2). */
export async function chooseCookiesFile() {
  let path: string | null = null;
  try {
    const r = await call<{ path?: string; cancelled?: boolean; error?: string }>("POST", "/api/choose-file", { purpose: "cookies" });
    if (r.cancelled) return;
    if (r.error) throw new Error(r.error);
    path = r.path ?? null;
  } catch {
    path = prompt("Path of the cookies.txt (an absolute path)")?.trim() || null;
  }
  if (path && (await putSettings({ instagramAuth: { kind: "file", path } }))) editInstagram(false);
}

// ---- Confirm and the log's buttons ---------------------------------------------------------------------------------

export async function confirmDownload(ids: string[], est: Record<string, number>): Promise<void> {
  const p = st.plan;
  if (!p?.destDir) return;
  try {
    const r = await call<{ jobId: number; rejected: { videoId: string; why: string }[] }>("POST", "/api/downloads/jobs", { option: st.choice.option, quality: st.choice.quality, destDir: p.destDir, videoIds: ids, estBytes: est });
    selectJob(r.jobId);
    st.view = "log";
    st.choice.excluded = new Set();
    emit();
    await refresh();
  } catch (e) {
    alert(`Could not start the download: ${(e as Error).message}`);
  }
}

async function act(url: string) {
  try {
    await call("POST", url);
  } catch (e) {
    alert((e as Error).message);
  }
  await refresh();
}
export const pauseQueue = () => act("/api/downloads/pause");
export const resumeQueue = () => act("/api/downloads/resume");
export const cancelJob = (id: number) => act(`/api/downloads/jobs/${id}/cancel`);
export const discardJob = (id: number) => act(`/api/downloads/jobs/${id}/discard`);
export const retryFailed = (id: number) => act(`/api/downloads/jobs/${id}/retry-failed`);
export const cancelItem = (id: number) => act(`/api/downloads/items/${id}/cancel`);
export const reportUrl = (jobId: number) => `/api/downloads/jobs/${jobId}/report.txt`;

// ---- the quit question (§4.7) --------------------------------------------------------------------------------------

/** ⏻: quits, asking first while downloads run. false when the owner said no. Throws what the server said otherwise. */
export async function quitAsking(): Promise<boolean> {
  const r = await fetch("/api/quit", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  if (r.ok) return true;
  const j = (await r.json().catch(() => null)) as { error?: string; running?: number; confirm?: boolean } | null;
  if (r.status === 409 && j?.confirm) {
    if (!confirm(quitQuestion(j.running ?? 1))) return false;
    await call("POST", "/api/quit", { force: true });
    return true;
  }
  throw new Error(j?.error ?? `${r.status}`);
}
