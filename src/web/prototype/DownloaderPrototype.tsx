// PROTOTYPE (#193) — throwaway, never merged to main. Three variants of the Downloader dialog (avatar menu → Download
// videos…) and of the card's download button, switchable with `?variant=A|B|C` and the floating bar at the bottom.
// Plan: "Three variants of the download dialog + card progress, on the existing Library route and avatar menu."
// The queue is faked in downloaderSim.ts; estimates are duration × a bitrate guess until the Reference size lands (#190).
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { VideoDto } from "../../shared/types";
import { TYPES, type VideoType } from "../../shared/filters";
import { useStore } from "../data";
import { Poster } from "../ui";
import { isNotHere, sourceLink } from "../../shared/presence";
import {
  DISK_FREE_MB, VARIANTS, bulkJobs, bulkTotals, cancelAll, enqueue, estMB, estS, fmtDur, fmtMB, isCandidate, openDownloader,
  proto, retryFailed, saveFailureReport, setPretend, setVariant, sim, startBulk, togglePause, useSim, type Job, type Quality,
} from "./downloaderSim";

const stop = (e: Event) => (e.preventDefault(), e.stopPropagation());
const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

type Opt = "full" | "random" | "type" | "artist" | "favorites";
const OPT_LABEL: Record<Opt, string> = { full: "Full archive", random: "Random", type: "By Type", artist: "By Artist", favorites: "Favorites" };
const OPTS: Opt[] = ["full", "random", "type", "artist", "favorites"];
const Q_LABEL: Record<Quality, string> = { "720p": "720p", "1080p": "1080p (default)", best: "Best" };

// ---------------------------------------------------------------- shared model (logic only; each variant owns its layout)
function useModel() {
  const { videos } = useStore();
  useSim();
  const cands = (videos ?? []).filter(isCandidate);
  const [opt, setOpt] = useState<Opt>("full");
  const [n, setN] = useState(20);
  const [seed, setSeed] = useState(1);
  const [type, setType] = useState<VideoType>("song");
  const artists = useMemo(() => {
    const m = new Map<string, { id: string; name: string; n: number }>();
    for (const v of cands) for (const a of v.artists) m.set(a.id, { id: a.id, name: a.nameLatin ?? a.name, n: (m.get(a.id)?.n ?? 0) + 1 });
    return [...m.values()].sort((a, b) => b.n - a.n);
  }, [cands.length]);
  const [artist, setArtist] = useState("");
  const artistId = artist || artists[0]?.id || "";
  const [quality, setQuality] = useState<Quality>("1080p");
  const [root, setRoot] = useState("Root");
  const [dest, setDest] = useState<string | null>(null); // null = the Root
  useEffect(() => {
    void fetch("/api/prototype/root").then((r) => r.json()).then((j: { path: string | null }) => j.path && setRoot(j.path));
  }, []);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [step, setStep] = useState<"options" | "selection" | "log">(sim.bulk ? "log" : "options");

  const poolFor = (o: Opt): VideoDto[] =>
    o === "full" ? cands
    : o === "random" ? [...cands].sort((a, b) => hash(a.id + seed) - hash(b.id + seed)).slice(0, n)
    : o === "type" ? cands.filter((v) => v.type === type)
    : o === "artist" ? cands.filter((v) => v.artists.some((a) => a.id === artistId))
    : cands.filter((v) => v.favoritedAt);
  const totals = (list: VideoDto[]) => {
    const mb = list.reduce((a, v) => a + estMB(v, quality), 0);
    return { n: list.length, mb, s: estS(mb), line: `${list.length} Videos · ${fmtMB(mb)} · ~${fmtDur(estS(mb))}` };
  };
  const pool = poolFor(opt);
  const selected = pool.filter((v) => !excluded.has(v.id));
  const sel = totals(selected);
  const toggle = (id: string) => {
    const s = new Set(excluded);
    s.has(id) ? s.delete(id) : s.add(id);
    setExcluded(s);
  };
  const choose = (o: Opt) => (setOpt(o), setExcluded(new Set()));
  return {
    cands, opt, choose, n, setN: (x: number) => (setN(Math.max(1, x)), setExcluded(new Set())), reroll: () => (setSeed(seed + 1), setExcluded(new Set())),
    type, setType: (t: VideoType) => (setType(t), setExcluded(new Set())), artists, artistId, setArtist: (a: string) => (setArtist(a), setExcluded(new Set())),
    quality, setQuality, root, dest: dest ?? root, isRoot: dest === null, inRoot: dest === null || dest === root || dest.startsWith(root + "/"),
    changeDest: async () => {
      const r = await fetch("/api/prototype/choose-folder", { method: "POST", body: JSON.stringify({ start: dest ?? root }) }).then((x) => x.json()) as { path?: string; error?: string };
      if (r.path) setDest(r.path === root ? null : r.path);
      else if (r.error) alert(r.error);
    },
    resetDest: () => setDest(null),
    poolFor, totals, pool, selected, sel, excluded, toggle,
    selectAll: () => setExcluded(new Set()), selectNone: () => setExcluded(new Set(pool.map((v) => v.id))),
    needsSelection: opt !== "full",
    tooBig: sel.mb > DISK_FREE_MB,
    step, setStep,
    start: () => (startBulk(selected, quality), setStep("log")),
    again: () => ((sim.bulk = null), setExcluded(new Set()), setStep("options")),
  };
}
type Model = ReturnType<typeof useModel>;

function OptExtra({ m, o }: { m: Model; o: Opt }) {
  if (o === "random")
    return (
      <span class="pdl-extra" onClick={(e) => e.stopPropagation()}>
        <input type="number" min={1} value={m.n} onInput={(e) => m.setN(+(e.target as HTMLInputElement).value)} />
        <button class="btn small" title="Pick another random set" onClick={m.reroll}>↻</button>
      </span>
    );
  if (o === "type")
    return (
      <select class="btn small" value={m.type} onClick={(e) => e.stopPropagation()} onChange={(e) => m.setType((e.target as HTMLSelectElement).value as VideoType)}>
        {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
    );
  if (o === "artist")
    return (
      <select class="btn small" value={m.artistId} onClick={(e) => e.stopPropagation()} onChange={(e) => m.setArtist((e.target as HTMLSelectElement).value)}>
        {m.artists.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.n})</option>)}
      </select>
    );
  return null;
}

function QualityPick({ m, compact }: { m: Model; compact?: boolean }) {
  return (
    <span class="pdl-seg" role="radiogroup" aria-label="Quality">
      {(["720p", "1080p", "best"] as Quality[]).map((q) => (
        <button key={q} role="radio" aria-checked={m.quality === q} class={m.quality === q ? "on" : ""} onClick={() => m.setQuality(q)}>
          {compact ? q : Q_LABEL[q]}
        </button>
      ))}
    </span>
  );
}

function DestRow({ m }: { m: Model }) {
  return (
    <div class="pdl-dest">
      <span class="dim">Into</span> <span class="mono pdl-path" title={m.dest}>{m.isRoot ? "Root" : m.dest}</span>
      <button class="btn small" onClick={() => void m.changeDest()}>Change…</button>
      {!m.isRoot && <button class="btn small" onClick={m.resetDest}>Back to Root</button>}
      {!m.inRoot && <div class="pdl-warn">This folder is outside the Root: the downloads won't appear in the library.</div>}
    </div>
  );
}

/** yt-dlp's own colours, roughly: progress numbers like its --color output, ERROR red, WARNING yellow, tags dim blue. */
function colorize(l: string): preact.ComponentChildren {
  if (l.startsWith("$ ")) return <><span class="t-g">$</span> {l.slice(2)}</>;
  if (l.startsWith("✓")) return <span class="t-g">{l}</span>;
  if (l.startsWith("ERROR:")) return <><span class="t-r t-b">ERROR:</span><span class="t-r">{l.slice(6)}</span></>;
  if (l.startsWith("WARNING:")) return <><span class="t-y t-b">WARNING:</span>{l.slice(8)}</>;
  if (l.startsWith("^C") || l.startsWith("‖") || l.startsWith("---")) return <span class="t-y">{l}</span>;
  const pm = /^(\[download\])(\s+)(\S+%)( of\s+)(\S+)( at\s+)(\S+)( ETA )(\S+)(.*)$/.exec(l);
  if (pm) return <><span class="t-c">{pm[1]}</span>{pm[2]}<span class="t-bl t-b">{pm[3]}</span>{pm[4]}<span class="t-m">{pm[5]}</span>{pm[6]}<span class="t-g">{pm[7]}</span>{pm[8]}<span class="t-y">{pm[9]}</span><span class="t-d">{pm[10]}</span></>;
  const tm = /^(\[[^\]]+\])(.*)$/.exec(l);
  if (tm) return <><span class={tm[1] === "[download]" ? "t-c" : tm[1] === "[Merger]" ? "t-m" : "t-bl"}>{tm[1]}</span>{tm[2]}</>;
  return l;
}

function Terminal({ lines, idle }: { lines: string[]; idle?: string }) {
  const el = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (el.current && stick.current) el.current.scrollTop = el.current.scrollHeight;
  });
  return (
    <pre class="pdl-term" ref={el} onScroll={(e) => { const p = e.currentTarget; stick.current = p.scrollHeight - p.scrollTop - p.clientHeight < 30; }}>
      {lines.length ? lines.map((l, i) => <div key={i}>{colorize(l)}</div>) : <div class="dim">{idle}</div>}
    </pre>
  );
}

function Bar({ pct, thin }: { pct: number; thin?: boolean }) {
  return <div class={`pdl-bar${thin ? " thin" : ""}`}><i style={{ width: `${pct}%` }} /></div>;
}

function FailActions() {
  const t = bulkTotals();
  if (!t.nFailed) return null;
  return (
    <span class="pdl-failacts">
      <button class="btn small" onClick={saveFailureReport}>Save failure report (.txt)</button>
      <button class="btn small" onClick={() => retryFailed(t.jobs.filter((j) => j.state === "failed").map((j) => j.id))}>Retry failed ({t.nFailed})</button>
    </span>
  );
}

function Art({ variant }: { variant: string }) {
  return (
    <div class={`pdl-art pdl-art-${variant}`} aria-hidden="true">
      <span>Artwork</span>
      <small>to be described</small>
    </div>
  );
}

function Shell({ variant, children }: { variant: string; children: preact.ComponentChildren }) {
  const d = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    d.current?.showModal();
    // nothing behind the dialog scrolls while it is open
    const h = document.documentElement, was = h.style.overflow;
    h.style.overflow = "hidden";
    return () => void (h.style.overflow = was);
  }, []);
  return (
    <dialog class={`pdl pdl-${variant}`} ref={d} onClose={() => openDownloader(false)} onCancel={() => openDownloader(false)}>
      <Art variant={variant} />
      <div class="pdl-right">
        <button class="pdl-x" aria-label="Close" onClick={() => d.current?.close()}>×</button>
        {children}
      </div>
      <ProtoBar />
    </dialog>
  );
}

// ---------------------------------------------------------------- Variant A — Stepper
function DialogA() {
  const m = useModel();
  const t = bulkTotals();
  const steps = ["What", "Pick", "Download"] as const;
  const at = m.step === "options" ? 0 : m.step === "selection" ? 1 : 2;
  return (
    <Shell variant="A">
      <ol class="pa-steps">
        {steps.map((s, i) => <li key={s} class={i === at ? "on" : i < at ? "past" : ""}>{i + 1}. {s}{i === 1 && !m.needsSelection && at < 2 ? " (skipped)" : ""}</li>)}
      </ol>
      {m.step === "options" && (
        <>
          <div class="pa-opts" role="radiogroup">
            {OPTS.map((o) => {
              const tt = m.totals(m.poolFor(o));
              return (
                <label key={o} class={`pa-opt${m.opt === o ? " on" : ""}${tt.n ? "" : " empty"}`}>
                  <input type="radio" name="pa-opt" checked={m.opt === o} onChange={() => m.choose(o)} />
                  <span class="pa-name">{OPT_LABEL[o]}</span>
                  <OptExtra m={m} o={o} />
                  <span class="pa-est">{tt.n} · {fmtMB(tt.mb)} · ~{fmtDur(tt.s)}</span>
                </label>
              );
            })}
          </div>
          <div class="pa-row"><span class="dim">Quality</span> <QualityPick m={m} /></div>
          <DestRow m={m} />
          <footer class="pa-foot">
            <span class="dim">{fmtMB(DISK_FREE_MB)} free</span>
            {m.needsSelection ? (
              <button class="btn primary" disabled={!m.pool.length} onClick={() => m.setStep("selection")}>Next: pick {m.pool.length} →</button>
            ) : (
              <button class="btn primary" disabled={!m.pool.length || m.tooBig} onClick={m.start}>Download {m.sel.line}</button>
            )}
          </footer>
        </>
      )}
      {m.step === "selection" && (
        <>
          <div class="pa-selhead">
            <b>{OPT_LABEL[m.opt]}</b> <span class="dim">uncheck to leave out</span>
            <button class="btn small" onClick={m.selectAll}>All</button>
            <button class="btn small" onClick={m.selectNone}>None</button>
          </div>
          <div class="pa-grid">
            {m.pool.map((v) => (
              <label key={v.id} class={`pa-tile${m.excluded.has(v.id) ? " off" : ""}`}>
                <Poster video={v} dur />
                <input type="checkbox" checked={!m.excluded.has(v.id)} onChange={() => m.toggle(v.id)} />
                <span class="pa-tt">{v.title}</span>
                <span class="dim small">{fmtMB(estMB(v, m.quality))}</span>
              </label>
            ))}
          </div>
          <footer class="pa-foot">
            <button class="btn" onClick={() => m.setStep("options")}>← Back</button>
            <span class={m.tooBig ? "pdl-warn" : "dim"}>{m.sel.line}{m.tooBig ? ` — only ${fmtMB(DISK_FREE_MB)} free` : ""}</span>
            <button class="btn primary" disabled={!m.sel.n || m.tooBig} onClick={m.start}>Confirm</button>
          </footer>
        </>
      )}
      {m.step === "log" && (
        <>
          <div class="pa-overall">
            <div class="pa-nums">
              <b>{Math.floor(t.pct)}%</b>
              <span>{t.nDone} done · {t.nLeft} left{t.nFailed ? ` · ${t.nFailed} failed` : ""}</span>
              <span class="dim">{fmtMB(t.done)} of {fmtMB(t.size)} · ~{fmtDur(t.etaS)} left{sim.paused ? " · paused" : ""}</span>
            </div>
            <Bar pct={t.pct} />
          </div>
          <Terminal lines={sim.lines} />
          <footer class="pa-foot">
            <button class="btn small" onClick={togglePause} disabled={!t.nLeft}>{sim.paused ? "Resume" : "Pause"}</button>
            <button class="btn small" onClick={cancelAll} disabled={!t.nLeft}>Cancel</button>
            <FailActions />
            {!t.nLeft && <button class="btn small" onClick={m.again}>New download</button>}
          </footer>
        </>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------- Variant B — One sheet
const TILE_HUE: Record<Opt, string> = { full: "var(--t6, #89b4fa)", random: "var(--t7, #cba6f7)", type: "var(--t5, #94e2d5)", artist: "var(--t2, #fab387)", favorites: "var(--t1, #f38ba8)" };
const fmtLen = (s: number | null) => (s == null ? "–" : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`);
const dlLabel = (n: number, mb: number) => `Download ${n} Video${n === 1 ? "" : "s"} (${fmtMB(mb)}) ~${fmtDur(estS(mb))}`;
const TERM_ICON = (
  <svg class="pb-termic" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <rect x="2.5" y="4" width="19" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8" />
    <path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);
/** Speed in the theme's red / yellow / green: under 1.5 MB/s slow, under 4 middling, else fast. */
const Speed = ({ v }: { v: number }) => <span class={`pb-speed ${v < 1.5 ? "slow" : v < 4 ? "mid" : "fast"}`}>{v.toFixed(1)} MB/s</span>;

function DialogB() {
  const m = useModel();
  const [showTerm, setShowTerm] = useState(false);
  const t = bulkTotals();
  if (m.step === "log")
    return (
      <Shell variant="B">
        <div class="pb-big">
          <span class="pb-pct">{Math.floor(t.pct)}<small>%</small></span>
          <span>
            <b>{t.nDone} of {t.jobs.length}</b> downloaded{t.nFailed ? <span class="pdl-bad"> · {t.nFailed} failed</span> : null}
            <br />
            <span class="dim">{fmtMB(t.done)} of {fmtMB(t.size)} ~{fmtDur(t.etaS)}</span> <span class="dim">·</span> <Speed v={t.speed} />
          </span>
        </div>
        <Bar pct={t.pct} />
        <ul class={`pb-jobs${showTerm ? " short" : ""}`}>
          {[...bulkJobs()].sort((a, b) => rank(a) - rank(b)).map((j) => (
            <li key={j.id} class={`pb-job ${j.state}`}>
              <span class="pb-ic">{j.state === "done" ? "✓" : j.state === "failed" ? "!" : j.state === "running" ? "↓" : ""}</span>
              <span class="pb-t">{j.title}<small class="dim">{j.state === "failed" ? j.reason : j.state === "running" ? <>{fmtMB(j.doneMB)} of {fmtMB(j.sizeMB)} ~{fmtDur((j.sizeMB - j.doneMB) / j.speed)} · <Speed v={j.speed} /></> : j.state === "cancelled" ? "cancelled" : `${fmtMB(j.sizeMB)}`}</small></span>
              {j.state === "running" && <Bar pct={(j.doneMB / j.sizeMB) * 100} thin />}
            </li>
          ))}
        </ul>
        <button class={`pb-termbtn${showTerm ? " open" : ""}`} aria-expanded={showTerm} onClick={() => setShowTerm(!showTerm)}>
          {TERM_ICON}
          <span>{showTerm ? "Hide" : "Show"} yt-dlp output</span>
          <span class="dim pb-termn">{sim.lines.length} lines{t.nFailed ? ` · ${t.nFailed} errors` : ""}</span>
        </button>
        {showTerm && <Terminal lines={sim.lines} />}
        <footer class="pb-foot">
          <button class="btn small" onClick={togglePause} disabled={!t.nLeft}>{sim.paused ? "Resume" : "Pause"}</button>
          <button class="btn small" onClick={cancelAll} disabled={!t.nLeft}>Cancel</button>
          <FailActions />
          {!t.nLeft && <button class="btn small" onClick={m.again}>New download</button>}
        </footer>
      </Shell>
    );
  const allOn = m.pool.length > 0 && m.excluded.size === 0;
  const someOn = m.selected.length > 0 && !allOn;
  return (
    <Shell variant="B">
      <h3 class="pb-h">Download Videos</h3>
      <div class="pb-tiles" role="radiogroup">
        {OPTS.map((o) => {
          const tt = m.totals(m.poolFor(o));
          return (
            // every tile keeps its control, so choosing one never changes the tiles' height
            <div key={o} role="radio" aria-checked={m.opt === o} tabIndex={0} class={`pb-tile${m.opt === o ? " on" : ""}${tt.n ? "" : " empty"}`} style={{ "--h": TILE_HUE[o] }} onClick={() => m.choose(o)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && m.choose(o)}>
              <span class="pb-tn">{OPT_LABEL[o]}</span>
              <span class="pb-tc">{tt.n}</span>
              <span class="pb-ts"><span>{fmtMB(tt.mb)}</span><span>~{fmtDur(tt.s)}</span></span>
              <span class="pb-tx" onFocusCapture={() => m.opt !== o && m.choose(o)}>{o === "full" ? <span class="dim">everything</span> : o === "favorites" ? <span class="dim">your ★ Videos</span> : <OptExtra m={m} o={o} />}</span>
            </div>
          );
        })}
      </div>
      <div class="pb-line"><QualityPick m={m} compact /> <DestRow m={m} /></div>
      <div class="pb-listwrap">
        {m.needsSelection ? (
          <div class="pb-fade" key={m.opt}>
            <div class="pb-listhead">
              <label>
                <input type="checkbox" checked={allOn} ref={(el) => void (el && (el.indeterminate = someOn))} onChange={() => (allOn ? m.selectNone() : m.selectAll())} />
                <span>{allOn ? "Deselect all" : "Select all"}</span>
              </label>
              <span class="dim">{m.selected.length} of {m.pool.length} picked · uncheck to leave out</span>
              <span class="pb-cols dim"><span>Length</span><span>Size</span></span>
            </div>
            <ul class="pb-list">
              {m.pool.map((v) => (
                <li key={v.id} class={m.excluded.has(v.id) ? "off" : ""}>
                  <label>
                    <input type="checkbox" checked={!m.excluded.has(v.id)} onChange={() => m.toggle(v.id)} />
                    <Poster video={v} />
                    <span class="pb-t">{v.title}<small class="dim">{v.artists.map((a) => a.nameLatin ?? a.name).join(", ") || v.type}</small></span>
                    <span class="mono pb-len">{fmtLen(v.durationS)}</span>
                    <span class="mono pb-size">{fmtMB(estMB(v, m.quality))}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div class="pb-fade pb-fullnote" key="full">
            <b>Every Video that is Not on this machine</b>
            <span class="dim">No picking: the whole archive goes in the queue, 2 at a time. Close this window and it keeps going.</span>
          </div>
        )}
      </div>
      <footer class="pb-sticky">
        <span class={m.tooBig ? "pdl-warn" : "dim"}>{fmtMB(DISK_FREE_MB)} free{m.tooBig ? " — not enough" : ""}</span>
        <button class="btn primary big" disabled={!m.sel.n || m.tooBig} onClick={m.start}>{dlLabel(m.sel.n, m.sel.mb)}</button>
      </footer>
    </Shell>
  );
}
const rank = (j: Job) => ({ running: 0, failed: 1, queued: 2, done: 3, cancelled: 4 })[j.state];

// ---------------------------------------------------------------- Variant C — Terminal-first
function DialogC() {
  const m = useModel();
  const { videos } = useStore();
  const t = bulkTotals();
  const live = m.step === "log";
  const state = (id: string) => sim.jobs.get(id);
  const rows = live ? bulkJobs().map((j) => videos?.find((v) => v.id === j.id) ?? null).filter((v): v is VideoDto => !!v) : m.pool;
  return (
    <Shell variant="C">
      <div class="pc-sentence">
        Download{" "}
        <select class="btn small" value={m.opt} disabled={live} onChange={(e) => m.choose((e.target as HTMLSelectElement).value as Opt)}>
          {OPTS.map((o) => <option key={o} value={o}>{OPT_LABEL[o]} ({m.poolFor(o).length})</option>)}
        </select>{" "}
        {!live && <OptExtra m={m} o={m.opt} />} at <QualityPick m={m} compact />
        <DestRow m={m} />
        <div class="pc-go">
          <span class={m.tooBig ? "pdl-warn" : "pc-est"}>{live ? `${t.jobs.length} Videos · ${fmtMB(t.size)}` : m.sel.line}</span>
          <span class="dim"> · {fmtMB(DISK_FREE_MB)} free</span>
          {!live ? (
            <button class="btn primary" disabled={!m.sel.n || m.tooBig} onClick={m.start}>Confirm</button>
          ) : t.nLeft ? (
            <>
              <button class="btn small" onClick={togglePause}>{sim.paused ? "Resume" : "Pause"}</button>
              <button class="btn small" onClick={cancelAll}>Cancel</button>
            </>
          ) : (
            <button class="btn small" onClick={m.again}>New download</button>
          )}
          <FailActions />
        </div>
      </div>
      <div class="pc-table-wrap">
        <table class="pc-table">
          <thead><tr><th></th><th></th><th>Title</th><th>Artist</th><th>Size</th><th>{live ? "Status" : "Time"}</th></tr></thead>
          <tbody>
            {rows.map((v) => {
              const j = live ? state(v.id) : undefined;
              return (
                <tr key={v.id} class={`${m.excluded.has(v.id) && !live ? "off" : ""} ${j?.state ?? ""}`}>
                  <td><input type="checkbox" disabled={live || m.opt === "full"} checked={live || !m.excluded.has(v.id)} onChange={() => m.toggle(v.id)} /></td>
                  <td class="pc-th"><Poster video={v} /></td>
                  <td class="pc-t">{v.title}</td>
                  <td class="dim">{v.artists.map((a) => a.nameLatin ?? a.name).join(", ")}</td>
                  <td class="mono">{fmtMB(j?.sizeMB ?? estMB(v, m.quality))}</td>
                  <td class="mono">
                    {!j ? `~${fmtDur(estS(estMB(v, m.quality)))}` : j.state === "running" ? `${Math.floor((j.doneMB / j.sizeMB) * 100)}%` : j.state === "failed" ? <span class="pdl-bad" title={j.reason}>failed</span> : j.state}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div class="pc-termwrap">
        <Bar pct={live ? t.pct : 0} thin />
        <div class="pc-termhead mono">
          {live ? `${Math.floor(t.pct)}% · ${t.nDone}/${t.jobs.length} done${t.nFailed ? ` · ${t.nFailed} failed` : ""} · ~${fmtDur(t.etaS)} left` : "yt-dlp 2026.10.22 · deno 2.5.4 · idle"}
        </div>
        <Terminal lines={live ? sim.lines : []} idle="$ waiting for Confirm…" />
      </div>
    </Shell>
  );
}

// ---------------------------------------------------------------- cards
function useCard(v: VideoDto) {
  useSim();
  const j = sim.jobs.get(v.id);
  const est = estMB(v, "1080p");
  const queuePos = j?.state === "queued" ? sim.order.filter((id) => sim.jobs.get(id)?.state === "queued").indexOf(v.id) + 1 : 0;
  const download = (e: Event) => (stop(e), enqueue([v], "1080p", true));
  const pct = j ? Math.floor((j.doneMB / j.sizeMB) * 100) : 0;
  const eta = j ? (j.sizeMB - j.doneMB) / j.speed : 0;
  return { j, est, queuePos, download, pct, eta };
}

const DL_ICON = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M12 3v12" /><path d="M7 10l5 5 5-5" /><path d="M4 21h16" />
  </svg>
);

function CardOutput({ j, onClose }: { j: Job; onClose: (e: Event) => void }) {
  return (
    <div class="pcard-out" onClick={stop}>
      <div class="pcard-outhead"><b class="pdl-bad">{j.reason}</b><button class="pdl-x" onClick={onClose}>×</button></div>
      <pre ref={(p) => void (p && (p.scrollTop = p.scrollHeight))}>{j.log.slice(-8).join("\n")}</pre>
      <button class="btn small" onClick={(e) => (stop(e), retryFailed([j.id]), onClose(e))}>Retry</button>
    </div>
  );
}

/** Over the poster: variants A and B. */
export function ProtoThumbOverlay({ v }: { v: VideoDto }) {
  const c = useCard(v);
  const [out, setOut] = useState(false);
  const close = (e: Event) => (stop(e), setOut(false));
  if (proto.variant === "A" || proto.variant === "B") {
    // B borrows A's card (owner's pick, 2026-11-08)
    const { j } = c;
    return (
      <div class="pa-card">
        {!j || j.state === "cancelled" ? (
          <button class="pa-dl" title={`Download · ${fmtMB(c.est)} · ~${fmtDur(estS(c.est))}`} onClick={c.download}>{DL_ICON}<span>{fmtMB(c.est)}</span></button>
        ) : j.state === "queued" ? (
          <span class="pa-pill">Queued #{c.queuePos}</span>
        ) : j.state === "running" ? (
          <span class="pa-pill run">{c.pct}% · {fmtDur(c.eta)}</span>
        ) : j.state === "failed" ? (
          <button class="pa-pill bad" onClick={(e) => (stop(e), setOut(!out))}>Failed ▾</button>
        ) : (
          <span class="pa-pill ok">✓ Downloaded</span>
        )}
        {j && (j.state === "running" || j.state === "queued") && <div class="pa-strip"><i style={{ width: `${c.pct}%` }} /></div>}
        {out && j?.state === "failed" && <CardOutput j={j} onClose={close} />}
      </div>
    );
  }
  // C: the corner mark becomes a progress ring
  const { j } = c;
  const r = 10, C = 2 * Math.PI * r;
  return (
    <span class={`pc-ring ${j?.state ?? "idle"}`} title={j ? j.state : "Not on this machine"}>
      <svg viewBox="0 0 24 24" width="26" height="26">
        <circle cx="12" cy="12" r={r} fill="rgba(0,0,0,.7)" stroke="rgba(255,255,255,.15)" stroke-width="2.4" />
        {j && <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" stroke-width="2.4" stroke-dasharray={`${(C * (j.state === "done" ? 100 : c.pct)) / 100} ${C}`} transform="rotate(-90 12 12)" stroke-linecap="round" />}
      </svg>
      <span class="pc-ring-ic">{!j || j.state === "cancelled" ? "↓" : j.state === "failed" ? "!" : j.state === "done" ? "✓" : j.state === "queued" ? "…" : ""}</span>
    </span>
  );
}

/** Under the tags: variant C only. */
export function ProtoCardBelow({ v }: { v: VideoDto }) {
  const c = useCard(v);
  const [out, setOut] = useState(true);
  if (proto.variant !== "C") return null;
  const { j } = c;
  return (
    <div class="pc-below" onClick={stop}>
      {!j || j.state === "cancelled" ? (
        <button class="btn small pc-dl" onClick={c.download}>↓ Download · {fmtMB(c.est)} · ~{fmtDur(estS(c.est))}</button>
      ) : j.state === "queued" ? (
        <span class="dim">Queued · #{c.queuePos} in line</span>
      ) : j.state === "running" ? (
        <span class="mono">{c.pct}% · {fmtMB(j.doneMB)}/{fmtMB(j.sizeMB)} · {fmtDur(c.eta)} left</span>
      ) : j.state === "failed" ? (
        <>
          <button class="btn small pdl-bad" onClick={() => setOut(!out)}>Failed {out ? "▴" : "▾"}</button>{" "}
          <button class="btn small" onClick={() => retryFailed([j.id])}>Retry</button>
          {out && <pre class="pc-out" ref={(p) => void (p && (p.scrollTop = p.scrollHeight))}>{j.log.slice(-6).join("\n")}</pre>}
        </>
      ) : (
        <span class="pdl-ok">✓ Downloaded — on this machine</span>
      )}
    </div>
  );
}

export const protoCardOn = (v: VideoDto) => isCandidate(v) || !!sim.jobs.get(v.id);

// ---------------------------------------------------------------- root: dialog + floating switcher
export function DownloaderPrototype() {
  useSim();
  const { videos } = useStore();
  const realNotHere = (videos ?? []).filter((v) => isNotHere(v) && sourceLink(v)).length;
  const i = VARIANTS.findIndex((v) => v.key === proto.variant);
  const cycle = (d: number) => setVariant(VARIANTS[(i + d + VARIANTS.length) % VARIANTS.length]!.key);
  useEffect(() => {
    // `[` and `]` cycle: the Library grid already owns ← and →
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (e.key === "[") cycle(-1);
      if (e.key === "]") cycle(1);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  });
  useEffect(() => {
    if (videos && realNotHere === 0 && !proto.pretend) setPretend(true);
  }, [!!videos]);
  const Dialog = proto.variant === "A" ? DialogA : proto.variant === "B" ? DialogB : DialogC;
  return (
    <>
      <style>{CSS}</style>
      {proto.open && <Dialog key={proto.variant} />}
      {!proto.open && <ProtoBar />}
    </>
  );
}

/** The floating switcher. Inside the dialog while it is open (a modal's top layer would cover it otherwise). */
function ProtoBar() {
  useSim();
  const i = VARIANTS.findIndex((v) => v.key === proto.variant);
  const cycle = (d: number) => setVariant(VARIANTS[(i + d + VARIANTS.length) % VARIANTS.length]!.key);
  return (
    <div class="proto-bar" role="toolbar" aria-label="Prototype variant switcher">
    <button onClick={() => cycle(-1)} aria-label="Previous variant">‹</button>
    <span>
      <b>{proto.variant}</b> — {VARIANTS[i]!.name}
    </span>
    <button onClick={() => cycle(1)} aria-label="Next variant">›</button>
    <span class="proto-sep" />
    <button onClick={() => openDownloader(!proto.open)}>{proto.open ? "Close dialog" : "Open dialog"}</button>
    <label title="Treat every Video with a source link as Not on this machine">
      <input type="checkbox" checked={proto.pretend} onChange={(e) => setPretend((e.target as HTMLInputElement).checked)} /> pretend
    </label>
    </div>
  );
}

const CSS = `
.proto-bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 2147483000; display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 999px; background: #fdf6e3; color: #111; font: 600 13px/1.2 system-ui, sans-serif; box-shadow: 0 6px 24px rgba(0,0,0,.6); border: 2px dashed #b58900; }
.proto-bar button { background: #111; color: #fdf6e3; border-radius: 999px; padding: 3px 10px; font-weight: 700; }
.proto-bar label { display: flex; gap: 4px; align-items: center; font-weight: 500; }
.pdl .proto-bar { bottom: auto; top: 10px; }
.proto-sep { width: 1px; height: 16px; background: #b58900; }

dialog.pdl { margin: auto; padding: 0; width: min(980px, calc(100vw - 32px)); height: min(680px, calc(100vh - 48px)); color: var(--fg); background: var(--bg2); border: 1px solid var(--line); border-radius: var(--r); box-shadow: 0 14px 40px rgba(0,0,0,.55); display: grid; grid-template-columns: 260px 1fr; overflow: hidden; }
dialog.pdl::backdrop { background: rgba(0,0,0,.6); }
.pdl-art { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: var(--fg3); background: repeating-linear-gradient(45deg, var(--bg3) 0 12px, var(--bg2) 12px 24px); border-right: 1px solid var(--line); font-size: 1.1em; }
.pdl-right { position: relative; display: flex; flex-direction: column; min-height: 0; padding: 18px 20px; gap: 12px; overflow: hidden; }
.pdl-x { position: absolute; right: 10px; top: 6px; font-size: 22px; color: var(--fg2); padding: 0 6px; }
.pdl-bar { height: 8px; border-radius: 99px; background: var(--bg3); overflow: hidden; flex: none; }
.pdl-bar.thin { height: 3px; }
.pdl-bar i { display: block; height: 100%; background: var(--accent); transition: width .25s linear; }
.pdl-term { flex: 1; min-height: 120px; margin: 0; overflow: auto; background: #0d0c0c; color: #c9c6bf; border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; font: 11.5px/1.45 var(--font-mono); white-space: pre-wrap; word-break: break-all; }
.pdl-term .t-r { color: #f38ba8; } .pdl-term .t-g { color: #a6e3a1; } .pdl-term .t-y { color: #f9e2af; } .pdl-term .t-bl { color: #89b4fa; } .pdl-term .t-c { color: #94e2d5; } .pdl-term .t-m { color: #cba6f7; } .pdl-term .t-d { color: #7f849c; } .pdl-term .t-b { font-weight: 700; }
.pdl-warn { color: #fabd2f; font-size: .9em; }
.pdl-bad { color: #fb4934; } .pdl-ok { color: #b8bb26; }
.pdl-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.pdl-seg button { padding: 3px 10px; font-size: .9em; } .pdl-seg button.on { background: var(--accent); color: var(--accent-fg); }
.pdl-dest { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: .92em; }
.pdl-dest .pdl-warn { flex-basis: 100%; }
.pdl-path { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pdl-extra { display: inline-flex; gap: 4px; } .pdl-extra input { width: 64px; padding: 2px 6px; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 6px; }
.pdl-failacts { display: inline-flex; gap: 6px; }
dialog.pdl .btn.primary { background: var(--accent); color: var(--accent-fg); border-color: var(--accent); font-weight: 600; }
dialog.pdl .btn.primary:hover:not(:disabled) { background: color-mix(in srgb, var(--accent) 85%, #fff); }
dialog.pdl .btn.primary:disabled { opacity: .45; }
.btn.big { padding: 9px 18px; font-size: 1.02em; }
.small { font-size: .85em; }

/* A */
.pa-steps { display: flex; gap: 18px; list-style: none; margin: 0; padding: 0 0 8px; border-bottom: 1px solid var(--line); color: var(--fg3); font-size: .92em; }
.pa-steps .on { color: var(--fg); font-weight: 600; } .pa-steps .past { color: var(--fg2); }
.pa-opts { display: flex; flex-direction: column; gap: 4px; }
.pa-opt { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
.pa-opt.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.pa-opt.empty { opacity: .5; }
.pa-name { font-weight: 600; min-width: 100px; }
.pa-est { margin-left: auto; color: var(--fg2); font-variant-numeric: tabular-nums; font-size: .92em; }
.pa-row { display: flex; align-items: center; gap: 10px; }
.pa-foot { margin-top: auto; display: flex; align-items: center; gap: 10px; justify-content: flex-end; padding-top: 10px; border-top: 1px solid var(--line); flex-wrap: wrap; }
.pa-foot > :first-child { margin-right: auto; }
.pa-selhead { display: flex; align-items: center; gap: 8px; }
.pa-grid { flex: 1; overflow: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 10px; align-content: start; }
.pa-tile { position: relative; display: flex; flex-direction: column; gap: 3px; cursor: pointer; font-size: .85em; }
.pa-tile input { position: absolute; left: 6px; top: 6px; width: 18px; height: 18px; }
.pdl .thumb.unavail img { filter: none; }
.pa-tile.off .thumb { opacity: .3; filter: grayscale(1); } .pa-tile.off .pa-tt { text-decoration: line-through; color: var(--fg3); }
.pa-tt { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.pa-overall { display: flex; flex-direction: column; gap: 6px; }
.pa-nums { display: flex; align-items: baseline; gap: 12px; } .pa-nums b { font-size: 1.6em; }

.pdl-thumbwrap { position: relative; }
.pa-card { position: absolute; inset: 0; pointer-events: none; }
.pa-card > * { pointer-events: auto; }
.pa-dl { position: absolute; left: 6px; top: 6px; display: flex; align-items: center; gap: 0; height: 28px; padding: 0 7px; border-radius: 99px; background: rgba(0,0,0,.75); color: #fff; overflow: hidden; }
.pa-dl span { max-width: 0; overflow: hidden; white-space: nowrap; transition: max-width .2s, margin .2s; font-size: 12px; }
.card:hover .pa-dl span { max-width: 90px; margin-left: 6px; }
.pa-dl:hover { background: var(--accent); color: var(--accent-fg); }
.pa-pill { position: absolute; left: 6px; top: 6px; padding: 3px 8px; border-radius: 99px; background: rgba(0,0,0,.78); color: #fff; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
.pa-pill.run { background: var(--accent); color: var(--accent-fg); } .pa-pill.bad { background: #cc241d; color: #fff; } .pa-pill.ok { background: #79740e; }
.pa-strip { position: absolute; left: 0; right: 0; bottom: 0; height: 4px; background: rgba(0,0,0,.6); border-radius: 0 0 6px 6px; overflow: hidden; }
.pa-strip i { display: block; height: 100%; background: var(--accent); transition: width .25s linear; }
.pcard-out { position: absolute; left: 0; right: 0; top: 36px; z-index: 5; background: #0d0c0c; border: 1px solid #cc241d; border-radius: 8px; padding: 6px 8px; box-shadow: 0 10px 30px rgba(0,0,0,.6); cursor: default; }
.pcard-out pre { margin: 4px 0 6px; max-height: 120px; overflow: auto; font: 10.5px/1.4 var(--font-mono); color: #c9c6bf; white-space: pre-wrap; word-break: break-all; }
.pcard-outhead { display: flex; justify-content: space-between; align-items: center; font-size: 12px; }
.pcard-outhead .pdl-x { position: static; font-size: 18px; }

/* B */
dialog.pdl-B { grid-template-columns: 200px 1fr; }
.pb-h { margin: 0; font-size: 1.15em; }
.pb-tiles { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; }
.pb-tile { --h: var(--accent); display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 10px; border: 1px solid color-mix(in srgb, var(--h) 30%, var(--line)); border-radius: 10px; font-size: .85em; cursor: pointer; background: color-mix(in srgb, var(--h) 7%, transparent); transition: background .18s, border-color .18s, box-shadow .18s, transform .18s; }
.pb-tile:hover { background: color-mix(in srgb, var(--h) 13%, transparent); }
.pb-tile.on { border-color: var(--h); background: color-mix(in srgb, var(--h) 18%, transparent); box-shadow: inset 0 0 0 1px var(--h), 0 6px 18px color-mix(in srgb, var(--h) 18%, transparent); }
.pb-tile.empty { opacity: .45; }
.pb-tn { font-weight: 600; color: var(--h); }
.pb-tc { font-size: 1.9em; font-weight: 600; line-height: 1.1; font-variant-numeric: tabular-nums; }
.pb-ts { display: flex; flex-wrap: wrap; column-gap: 10px; white-space: nowrap; color: var(--fg2); font-variant-numeric: tabular-nums; }
.pb-tx { margin-top: 4px; min-height: 26px; display: flex; align-items: center; max-width: 100%; }
.pb-tx select { max-width: 100%; }
dialog.pdl select.btn { appearance: none; -webkit-appearance: none; padding-right: 26px; line-height: 1.3; text-overflow: ellipsis; background: color-mix(in srgb, var(--fg) 7%, transparent) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M4 6l4 4 4-4' fill='none' stroke='%239aa1b7' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E") no-repeat right 7px center / 13px; }
.pb-line { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.pb-listwrap { flex: 1; min-height: 0; display: flex; flex-direction: column; border-top: 1px solid var(--line); }
.pb-fade { flex: 1; min-height: 0; display: flex; flex-direction: column; animation: pb-in .22s ease-out; }
@keyframes pb-in { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.pb-listhead { display: flex; align-items: center; gap: 12px; padding: 6px 2px; border-bottom: 1px solid var(--line); font-size: .88em; }
.pb-listhead label { display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 600; }
.pb-cols { margin-left: auto; display: grid; grid-template-columns: 52px 64px; text-align: right; gap: 10px; }
.pb-list { flex: 1; min-height: 0; overflow: auto; list-style: none; margin: 0; padding: 0; }
.pb-list label { display: grid; grid-template-columns: 20px 64px 1fr 52px 64px; align-items: center; gap: 10px; padding: 5px 2px; border-bottom: 1px solid var(--line); cursor: pointer; }
.pb-list .thumb { width: 64px; }
.pb-len, .pb-size { text-align: right; font-size: .85em; color: var(--fg2); }
.pb-list li { transition: opacity .15s; } .pb-list li.off { opacity: .4; }
.pb-fullnote { justify-content: center; align-items: center; text-align: center; gap: 6px; padding: 20px; }
.pb-t { display: flex; flex-direction: column; min-width: 0; } .pb-t small { font-size: .8em; }
.pb-sticky { margin-top: auto; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 10px; border-top: 1px solid var(--line); }
.pb-big { display: flex; align-items: center; gap: 18px; }
.pb-pct { font-size: 3.4em; font-weight: 600; line-height: 1; font-variant-numeric: tabular-nums; } .pb-pct small { font-size: .45em; color: var(--fg2); }
.pb-jobs { flex: 1; min-height: 80px; overflow: auto; list-style: none; margin: 0; padding: 0; }
.pb-jobs.short { flex: 0 1 30%; }
.pb-job { display: grid; grid-template-columns: 22px 1fr 120px; align-items: center; gap: 8px; padding: 4px 0; border-bottom: 1px solid var(--line); font-size: .9em; }
.pb-job .pb-ic { text-align: center; font-weight: 700; color: var(--fg3); }
.pb-job.done .pb-ic { color: var(--ok, #b8bb26); } .pb-job.failed .pb-ic, .pb-job.failed small { color: var(--no, #fb4934); } .pb-job.running .pb-ic { color: var(--accent); }
.pb-job.done, .pb-job.cancelled { opacity: .55; }
.pb-termbtn { display: flex; align-items: center; gap: 10px; width: 100%; padding: 9px 12px; border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--line)); border-radius: 8px; background: color-mix(in srgb, var(--accent) 9%, #0d0c0c); color: var(--fg); font-weight: 600; text-align: left; transition: background .15s; }
.pb-termbtn:hover { background: color-mix(in srgb, var(--accent) 16%, #0d0c0c); }
.pb-termic { flex: none; display: block; color: var(--accent); }
.pb-speed { font-weight: 600; font-variant-numeric: tabular-nums; } .pb-speed.slow { color: var(--no, #fb4934); } .pb-speed.mid { color: var(--t3, #fabd2f); } .pb-speed.fast { color: var(--ok, #b8bb26); }
.pb-termn { margin-left: auto; font-weight: 400; font-size: .88em; }
.pb-foot { display: flex; gap: 8px; flex-wrap: wrap; }
/* C */
dialog.pdl-C { grid-template-columns: 72px 1fr; width: min(1100px, calc(100vw - 32px)); height: min(760px, calc(100vh - 48px)); }
.pdl-art-C span { writing-mode: vertical-rl; } .pdl-art-C small { display: none; }
.pc-sentence { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 1.05em; padding-right: 24px; }
.pc-sentence .pdl-dest { flex-basis: 100%; }
.pc-go { flex-basis: 100%; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pc-est { font-weight: 600; } .pc-go .btn.primary { margin-left: auto; }
.pc-table-wrap { flex: 1; min-height: 120px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
.pc-table { width: 100%; border-collapse: collapse; font-size: .86em; }
.pc-table th { position: sticky; top: 0; background: var(--bg3); text-align: left; font-weight: 600; padding: 4px 6px; color: var(--fg2); }
.pc-table td { padding: 3px 6px; border-top: 1px solid var(--line); white-space: nowrap; }
.pc-table .pc-t { white-space: normal; max-width: 380px; }
.pc-th .thumb { width: 48px; }
.pc-table tr.off { opacity: .4; } .pc-table tr.done { opacity: .55; } .pc-table tr.running td { color: var(--accent); }
.pc-termwrap { flex: none; height: 210px; display: flex; flex-direction: column; gap: 0; }
.pc-termhead { font-size: 11px; color: var(--fg2); padding: 4px 2px; }
.pc-ring { position: absolute; left: 4px; top: 4px; display: grid; place-items: center; color: var(--accent); }
.pc-ring svg { grid-area: 1/1; } .pc-ring-ic { grid-area: 1/1; color: #fff; font-size: 12px; font-weight: 700; }
.pc-ring.failed { color: #cc241d; } .pc-ring.done { color: #98971a; }
.card:has(.pc-ring.failed) { box-shadow: inset 0 0 0 2px #cc241d; }
.pc-below { margin-top: 6px; font-size: .85em; cursor: default; }
.pc-dl { width: 100%; text-align: center; }
.pc-out { margin: 6px 0 0; max-height: 110px; overflow: auto; background: #0d0c0c; color: #c9c6bf; border: 1px solid #cc241d; border-radius: 6px; padding: 5px 7px; font: 10.5px/1.4 var(--font-mono); white-space: pre-wrap; word-break: break-all; }
`;
