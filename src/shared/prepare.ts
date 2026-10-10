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
}

/**
 * Requests the Copy once (a 1-byte Range, which also puts a not-yet-made Fallback at the front of the ffmpeg queue)
 * and, on a 503 with a Fallback state, polls until it is ready. "failed" covers a gone Copy, a failed Fallback and a
 * drive hiccup (a 503 with no Fallback state).
 */
export async function awaitCopy(id: number, deps: PrepareDeps): Promise<PrepareResult> {
  const first = await deps.fetch(`/copy/${id}`, { headers: { range: "bytes=0-0" } }).catch(() => null);
  if (deps.cancelled()) return "cancelled";
  if (!first) return "failed";
  if (first.status !== 503) {
    void first.body?.cancel();
    return first.ok ? "ready" : "failed";
  }
  const body = (await first.json().catch(() => ({}))) as { state?: string; progress?: number | null };
  if (!body.state) return "failed";
  deps.onProgress(typeof body.progress === "number" ? body.progress : null);
  for (;;) {
    await deps.sleep(deps.pollMs ?? 700);
    if (deps.cancelled()) return "cancelled";
    const res = await deps.fetch(`/api/copies/${id}`).catch(() => null);
    const c = res && res.ok ? ((await res.json().catch(() => null)) as { fallback?: { state: string; progress?: number | null; error?: string } } | null) : null;
    if (!c) continue;
    const st = readPrepare(c.fallback);
    if (st.kind === "ready") return "ready";
    if (st.kind === "failed") return "failed";
    deps.onProgress(st.progress);
  }
}
