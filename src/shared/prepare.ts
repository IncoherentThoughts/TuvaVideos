// The client side of the "preparing" contract (spec 3.3, 3.4): `GET /copy/:id` answers 503 + JSON state while a
// Fallback is made; the UI polls `/api/copies/:id` and starts playback when it is ready. The fetch and the clock are
// injected so a stub can drive it in tests.
import { readPrepare } from "./copies";

export type PrepareResult = "ready" | "failed" | "cancelled";

export interface PrepareDeps {
  fetch: (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<any>; body?: { cancel(): unknown } | null }>;
  sleep: (ms: number) => Promise<void>;
  /** Called with the Fallback's progress (0..1, null when unknown) every time the overlay should update. */
  onProgress: (progress: number | null) => void;
  cancelled: () => boolean;
  pollMs?: number;
  /** Overall limit on the wait (default an hour). */
  maxWaitMs?: number;
}

/** Poll failures in a row (a dead server, a 500) before giving up. */
const MAX_POLL_FAILURES = 10;
/** How often a Fallback that went back to "none" is asked for again before giving up. */
const MAX_REREQUESTS = 3;
/** The longest wait for a Fallback (a 2 h film transcodes in about 6 min). */
const MAX_WAIT_MS = 60 * 60_000;

type First = { done: PrepareResult } | { progress: number | null };

/** One `GET /copy/:id` (a 1-byte Range): ready, failed, or a Fallback being made (a 503 carrying its state). */
async function requestCopy(id: number, deps: PrepareDeps): Promise<First> {
  const first = await deps.fetch(`/copy/${id}`, { headers: { range: "bytes=0-0" } }).catch(() => null);
  if (deps.cancelled()) return { done: "cancelled" };
  if (!first) return { done: "failed" };
  if (first.status !== 503) {
    void first.body?.cancel();
    return { done: first.ok ? "ready" : "failed" };
  }
  const body = (await first.json().catch(() => ({}))) as { state?: string; progress?: number | null };
  if (!body.state) return { done: "failed" };
  return { progress: typeof body.progress === "number" ? body.progress : null };
}

/**
 * Requests the Copy once (a 1-byte Range, which also puts a not-yet-made Fallback at the front of the ffmpeg queue)
 * and, on a 503 with a Fallback state, polls until it is ready. "failed" covers a gone Copy, a failed Fallback and a
 * drive hiccup (a 503 with no Fallback state). The wait is bounded (audit PLAY-11): a gone Copy (404) or repeated poll
 * failures fail, a Fallback state of `none` (the job was dropped, or the Copy now plays as-is) asks `/copy/:id` again,
 * and an overall deadline ends it.
 */
export async function awaitCopy(id: number, deps: PrepareDeps): Promise<PrepareResult> {
  let r = await requestCopy(id, deps);
  if ("done" in r) return r.done;
  deps.onProgress(r.progress);
  const pollMs = deps.pollMs ?? 700;
  let waited = 0;
  let failures = 0;
  let rerequests = 0;
  for (;;) {
    await deps.sleep(pollMs);
    waited += pollMs;
    if (deps.cancelled()) return "cancelled";
    if (waited > (deps.maxWaitMs ?? MAX_WAIT_MS)) return "failed";
    const res = await deps.fetch(`/api/copies/${id}`).catch(() => null);
    if (res?.status === 404) return "failed"; // the Copy was deleted meanwhile
    const c = res && res.ok ? ((await res.json().catch(() => null)) as { fallback?: { state: string; progress?: number | null; error?: string } } | null) : null;
    if (!c) {
      if (++failures >= MAX_POLL_FAILURES) return "failed";
      continue;
    }
    failures = 0;
    if (c.fallback?.state === "none" || !c.fallback) {
      if (++rerequests > MAX_REREQUESTS) return "failed";
      r = await requestCopy(id, deps);
      if ("done" in r) return r.done;
      deps.onProgress(r.progress);
      continue;
    }
    const st = readPrepare(c.fallback);
    if (st.kind === "ready") return "ready";
    if (st.kind === "failed") return "failed";
    deps.onProgress(st.progress);
  }
}
