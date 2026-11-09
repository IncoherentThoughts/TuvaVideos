// The card's download button and its progress states (downloader-spec §8), and the same button on the Player's Not on
// this machine panel. One module-level copy of `GET /api/downloads`'s per-Video map serves every card; it is re-read
// at 1 s while a card on screen is queued or running (cardDownloadState.ts pollInterval).
import { createPortal } from "preact/compat";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { VideoDto } from "../shared/types";
import { loadVideos } from "./data";
import { cardState, formatEstimate, newlyDone, pollInterval, tailAtError, type CardItem, type CardState } from "./cardDownloadState";

// ---- the shared map and its polling -------------------------------------------------------------------------------

let map: Record<string, CardItem | undefined> = {};
let logCursor = 0;
let loaded = false;
const onScreen = new Map<string, number>();
const subs = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inflight: Promise<void> | null = null;

function schedule() {
  if (timer) clearTimeout(timer);
  timer = null;
  const ms = pollInterval(onScreen.keys(), map);
  if (ms != null) timer = setTimeout(() => void refreshCardDownloads(), ms);
}

/** Re-reads the queue's per-Video map now (after a click, or when something else started a job). */
export function refreshCardDownloads(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const r = await fetch(`/api/downloads?logCursor=${logCursor}`);
      if (!r.ok) return;
      const s = (await r.json()) as { videos?: Record<string, CardItem>; log?: { cursor?: number } };
      const next = s.videos ?? {};
      // "✓ Downloaded until the next poll shows the Copy": the grid's data is reloaded once the item is done.
      const done = loaded ? newlyDone(map, next) : [];
      map = next;
      loaded = true;
      logCursor = s.log?.cursor ?? 0;
      for (const f of subs) f();
      if (done.length) void loadVideos();
    } catch {
      /* offline server: try again at the next tick */
    } finally {
      inflight = null;
      schedule();
    }
  })();
  return inflight;
}

function useCardItem(videoId: string): CardItem | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    subs.add(f);
    onScreen.set(videoId, (onScreen.get(videoId) ?? 0) + 1);
    if (!loaded || onScreen.size === 1) void refreshCardDownloads();
    else if (!timer && !inflight) schedule();
    return () => {
      subs.delete(f);
      const n = (onScreen.get(videoId) ?? 1) - 1;
      if (n > 0) onScreen.set(videoId, n);
      else onScreen.delete(videoId);
      if (onScreen.size === 0 && timer) (clearTimeout(timer), (timer = null));
    };
  }, [videoId]);
  return map[videoId];
}

async function post(path: string, body?: unknown): Promise<{ ok: boolean; status: number; error?: string }> {
  try {
    const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    return { ok: r.ok, status: r.status, error: j.error };
  } catch (e) {
    return { ok: false, status: 0, error: (e as Error).message };
  }
}

// ---- the hover estimate -------------------------------------------------------------------------------------------

const estimates = new Map<string, Promise<number | null>>();
function estimateOf(videoId: string): Promise<number | null> {
  let p = estimates.get(videoId);
  if (!p) {
    p = fetch(`/api/downloads/card/estimate?videoId=${encodeURIComponent(videoId)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { estBytes?: number | null } | null) => j?.estBytes ?? null)
      .catch(() => (estimates.delete(videoId), null));
    estimates.set(videoId, p);
  }
  return p;
}

// ---- the button and its states ------------------------------------------------------------------------------------

const stop = (e: Event) => {
  // Inside the card's link: never open the Player.
  e.preventDefault();
  e.stopPropagation();
};

function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M12 3v12" />
      <path d="M7 10l5 5 5-5" />
      <path d="M4 21h16" />
    </svg>
  );
}

function useDownload(videoId: string) {
  const item = useCardItem(videoId);
  const st = cardState(item);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await post("/api/downloads/card", { videoId });
    if (!r.ok) {
      if (r.status === 409 && /already/.test(r.error ?? "")) void loadVideos();
      else setError(r.error ?? "could not start");
    }
    await refreshCardDownloads();
    setBusy(false);
  };
  return { st, start, busy, error };
}

/** The card's corner: the round button (idle) or the state's pill, and the 4 px strip while running. */
export function CardDownload({ video }: { video: Pick<VideoDto, "id" | "title"> }) {
  const { st, start, busy, error } = useDownload(video.id);
  const [est, setEst] = useState<string | null>(null);
  const hover = () => void estimateOf(video.id).then((b) => setEst(formatEstimate(b)));
  return (
    <div class={`cdl cdl-${st.kind}`} data-cdl={st.kind} onClick={stop}>
      {st.kind === "idle" ? (
        <button
          type="button"
          class={`cdl-btn${error ? " err" : ""}`}
          aria-label={`Download ${video.title}${est ? ` (${est})` : ""}`}
          title={error ? `Download did not start: ${error}` : "Download to this machine"}
          disabled={busy}
          onMouseEnter={hover}
          onFocus={hover}
          onClick={(e) => (stop(e), void start())}
        >
          <DownloadIcon />
          <span class="cdl-est">{error ? error : (est ?? "≈ …")}</span>
        </button>
      ) : (
        <StatePill st={st} />
      )}
      {(st.kind === "running" || st.kind === "merging" || st.kind === "adding") && (
        <div class="cdl-strip" aria-hidden="true">
          <i style={{ width: `${st.kind === "running" ? Math.round((st.fraction ?? 0) * 100) : 100}%` }} />
        </div>
      )}
    </div>
  );
}

function StatePill({ st }: { st: Exclude<CardState, { kind: "idle" }> }) {
  if (st.kind === "failed") return <FailedPill st={st} />;
  return (
    <span class={`cdl-pill ${st.kind}`} role="status">
      {st.label}
    </span>
  );
}

function FailedPill({ st }: { st: Extract<CardState, { kind: "failed" }> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" ref={ref} class="cdl-pill failed" aria-haspopup="dialog" aria-expanded={open} title={`Failed: ${st.reason}`} onClick={(e) => (stop(e), setOpen(!open))}>
        {st.label}
      </button>
      {open && createPortal(<FailedPopup st={st} anchor={ref.current} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function FailedPopup({ st, anchor, onClose }: { st: Extract<CardState, { kind: "failed" }>; anchor: HTMLElement | null; onClose: () => void }) {
  const [log, setLog] = useState<{ lines: string[]; scrollTo: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const errLine = useRef<HTMLDivElement>(null);
  const r = anchor?.getBoundingClientRect();
  const left = r ? Math.max(8, Math.min(r.left, window.innerWidth - 368)) : 16;
  const top = r ? r.bottom + 6 : 16;

  useEffect(() => {
    let alive = true;
    fetch(`/api/downloads/items/${st.itemId}/log?tail=200`)
      .then((x) => x.json())
      .then((j: { lines?: string[]; errorAt?: number }) => alive && setLog(tailAtError(j.lines ?? [], j.errorAt ?? -1)))
      .catch(() => alive && setLog({ lines: [], scrollTo: -1 }));
    return () => {
      alive = false;
    };
  }, [st.itemId]);
  useLayoutEffect(() => {
    const el = errLine.current;
    const pre = el?.parentElement;
    if (el && pre) pre.scrollTop = el.offsetTop - pre.clientHeight / 2;
  }, [log]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !anchor?.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && (e.stopPropagation(), onClose());
    const scroll = (e: Event) => !box.current?.contains(e.target as Node) && onClose();
    document.addEventListener("mousedown", down, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("mousedown", down, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [anchor, onClose]);

  const act = async (what: "retry" | "dismiss") => {
    setBusy(true);
    await post(`/api/downloads/items/${st.itemId}/${what}`);
    await refreshCardDownloads();
    setBusy(false);
    onClose();
  };
  return (
    <div class="cdl-pop" ref={box} role="dialog" aria-label="Download failed" style={{ left: `${left}px`, top: `${top}px` }}>
      <div class="cdl-pop-reason">
        Failed: <b>{st.reason}</b>
      </div>
      <div class="cdl-log" tabIndex={0} aria-label="yt-dlp output">
        {log === null ? (
          <div class="dim">loading the log…</div>
        ) : log.lines.length === 0 ? (
          <div class="dim">No output was kept for this download.</div>
        ) : (
          log.lines.map((l, i) => (
            <div key={i} ref={i === log.scrollTo ? errLine : undefined} class={i === log.scrollTo && /ERROR:/.test(l) ? "err" : undefined}>
              {l}
            </div>
          ))
        )}
      </div>
      <div class="cdl-pop-acts">
        <button type="button" class="btn primary" disabled={busy} onClick={() => void act("retry")}>
          Retry
        </button>
        <button type="button" class="btn" disabled={busy} onClick={() => void act("dismiss")}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** The Player's Not on this machine panel: a Download button beside the source link, then the same states. */
export function PanelDownload({ video }: { video: Pick<VideoDto, "id" | "title"> }) {
  const { st, start, busy, error } = useDownload(video.id);
  const [est, setEst] = useState<string | null>(null);
  useEffect(() => void estimateOf(video.id).then((b) => setEst(formatEstimate(b))), [video.id]);
  return (
    <span class="cdl-panel" data-cdl={st.kind}>
      {st.kind === "idle" ? (
        <button type="button" class="btn primary cdl-panel-btn" disabled={busy} onClick={() => void start()}>
          <DownloadIcon /> Download{est ? ` (${est})` : ""}
        </button>
      ) : (
        <StatePill st={st} />
      )}
      {error && <span class="dim cdl-panel-err">Did not start: {error}</span>}
    </span>
  );
}
