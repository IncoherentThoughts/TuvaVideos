// The download dialog (docs/downloader-spec.md §7), variant B "One sheet" of the #193 prototype on the real queue (§6):
// the Artwork placeholder on the left; on the right the chooser (option tiles, quality, destination, picker, footer)
// and, after Confirm, the job's log. State and HTTP are in store.ts, the pure rules in model.ts.
import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import type { PlanOption, PlanResponse } from "../../server/downloadPlan";
import { reasonWords } from "../../server/downloads/report";
import type { Quality } from "../../shared/downloadEstimate";
import type { VideoType } from "../../shared/filters";
import { Poster } from "../ui";
import {
  colorLine, confirmBlock, confirmLabel, displayLine, fmtBytes, fmtDur, fmtLen, fmtSpeed, headline, heldStatus, isLive, paceOf, picked,
  ROW_MARK, rowGroup, selectAllState, sortRows, tileLine, videos as nVideos, BROWSER_LABEL, browserNote, hasInstagram, instagramStatus, INSTAGRAM_NOTICE,
} from "./model";
import {
  cancelItem, cancelJob, chooseFolder, choose, closeDownloads, confirmDownload, installTools, newDownload, pauseQueue, reportUrl, resumeQueue,
  retryFailed, setExcluded, toggleVideo, useDownloads, type ItemDto, type JobDto, acknowledgeInstagramNotice, chooseCookiesFile, editInstagram,
  setInstagramAuth,
} from "./store";
import type { Browser } from "../../server/downloads/instagramAuth";

const OPTS: PlanOption[] = ["full", "random", "type", "artist", "favorites"];
const OPT_LABEL: Record<PlanOption, string> = { full: "Full archive", random: "Random", type: "By Type", artist: "By Artist", favorites: "Favorites" };
/** Each tile in its own theme hue (§7.2). */
const TILE_HUE: Record<PlanOption, string> = { full: "var(--t6)", random: "var(--t7)", type: "var(--t5)", artist: "var(--t2)", favorites: "var(--t1)" };
const QUALITIES: { q: Quality; label: string }[] = [{ q: "720p", label: "720p" }, { q: "1080p", label: "1080p" }, { q: "best", label: "Best" }];

const TERM_ICON = (
  <svg class="dl-termic" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
    <rect x="2.5" y="4" width="19" height="16" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8" />
    <path d="M7 9.5l3 2.5-3 2.5M12.5 15h4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
);

/** Mounted once (main.tsx); renders only while open. */
export function DownloadDialogHost() {
  const s = useDownloads();
  return s.open ? <DownloadDialog /> : null;
}

function DownloadDialog() {
  const s = useDownloads();
  const d = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    d.current?.showModal();
    // the page behind does not scroll (§7.1)
    const h = document.documentElement;
    const was = h.style.overflow;
    h.style.overflow = "hidden";
    return () => void (h.style.overflow = was);
  }, []);
  return (
    <dialog class="dl" ref={d} aria-label="Download Videos" onClose={closeDownloads} onCancel={closeDownloads}>
      <div class="dl-art" aria-hidden="true">
        <span>Artwork</span>
        <small>to be described</small>
      </div>
      <div class="dl-right">
        <button class="dl-x" aria-label="Close" title="Close (the downloads keep going)" onClick={() => d.current?.close()}>
          ×
        </button>
        <ToolsRow />
        {s.view === "log" ? <Log /> : <Chooser />}
      </div>
    </dialog>
  );
}

// ---- tools (§2.5) --------------------------------------------------------------------------------------------------

function ToolsRow() {
  const { tools } = useDownloads();
  if (!tools) return null;
  const i = tools.install;
  if (i.running)
    return (
      <div class="dl-tools" role="status">
        Installing {i.tool ?? "tools"}… {i.receivedBytes > 0 && <span class="dim">({fmtBytes(i.receivedBytes)}{i.totalBytes ? ` of ${fmtBytes(i.totalBytes)}` : ""})</span>}
      </div>
    );
  const noYtdlp = tools.ytdlp.source === "missing";
  const noJs = tools.jsRuntime.kind === "none";
  if (!noYtdlp && !noJs && !i.error) return null;
  return (
    <div class="dl-tools" role="status">
      {noYtdlp ? <span>yt-dlp is not installed. Downloads need it.</span> : noJs ? <span>YouTube needs deno; it will be installed when you are online.</span> : null}
      {i.error && <span class="dl-bad"> Install failed: {i.error}</span>}
      {(noYtdlp || noJs) && (
        <button class="btn small" onClick={() => void installTools()}>
          Install {noYtdlp ? "yt-dlp" : "deno"}
        </button>
      )}
    </div>
  );
}

// ---- choosing (§7.2) -----------------------------------------------------------------------------------------------

function TileControl({ o, plan }: { o: PlanOption; plan: PlanResponse }) {
  const { choice } = useDownloads();
  const [n, setN] = useState(String(choice.n));
  useEffect(() => setN(String(choice.n)), [choice.n]);
  const stop = (e: Event) => e.stopPropagation();
  // using a tile's control selects the tile (§7.2)
  const sel = choice.option === o ? {} : { option: o };
  if (o === "random")
    return (
      <span class="dl-extra" onClick={stop}>
        <input
          type="number"
          min={1}
          aria-label="How many"
          value={n}
          onInput={(e) => {
            const v = (e.target as HTMLInputElement).value;
            setN(v);
            const x = Math.floor(Number(v));
            if (x >= 1) choose({ ...sel, n: x }, 300);
          }}
          onFocus={() => choice.option !== o && choose({ option: o })}
        />
        <button class="btn small" title="Pick another random set" aria-label="Pick another random set" onClick={() => choose({ ...sel, seed: Math.floor(Math.random() * 2 ** 31) })}>
          ↻
        </button>
      </span>
    );
  if (o === "type")
    return (
      <select class="btn small" aria-label="Type" value={choice.type ?? ""} disabled={!plan.types.length} onClick={stop} onChange={(e) => choose({ ...sel, type: (e.target as HTMLSelectElement).value as VideoType })}>
        {!plan.types.length && <option value="">none</option>}
        {plan.types.map((t) => (
          <option key={t.type} value={t.type}>
            {t.type} ({t.count})
          </option>
        ))}
      </select>
    );
  if (o === "artist")
    return (
      <select class="btn small" aria-label="Artist" value={choice.artistId ?? ""} disabled={!plan.artists.length} onClick={stop} onChange={(e) => choose({ ...sel, artistId: (e.target as HTMLSelectElement).value })}>
        {!plan.artists.length && <option value="">none</option>}
        {plan.artists.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name} ({a.count})
          </option>
        ))}
      </select>
    );
  return <span class="dim">{o === "full" ? "everything" : "your ★ Videos"}</span>;
}

function Chooser() {
  const s = useDownloads();
  const { plan, choice, tools } = s;
  const [busy, setBusy] = useState(false);
  if (!plan)
    return (
      <>
        <h3 class="dl-h">Download Videos</h3>
        <div class="dl-empty">{s.planError ? <span class="dl-bad">{s.planError}</span> : <span class="dim">Reading the library…</span>}</div>
      </>
    );
  const { videos: chosen, totals } = picked(plan.videos, choice.excluded, plan.throughputBps);
  const all = selectAllState(plan.videos.length, plan.videos.filter((v) => choice.excluded.has(v.id)).length);
  const block = confirmBlock({ count: totals.count, estBytes: totals.estBytes, freeBytes: plan.freeBytes, destDir: plan.destDir, toolsMissing: tools?.ytdlp.source === "missing", busy });
  const confirm = async () => {
    setBusy(true);
    const est: Record<string, number> = {};
    for (const v of chosen) if (v.estBytes != null) est[v.id] = v.estBytes;
    await confirmDownload(chosen.map((v) => v.id), est);
    setBusy(false);
  };
  const tooSmall = plan.freeBytes != null && block === "not enough free space";
  return (
    <>
      <h3 class="dl-h">Download Videos</h3>
      <div class="dl-tiles" role="radiogroup" aria-label="What to download">
        {OPTS.map((o) => {
          const t = plan.options[o];
          const line = tileLine(t);
          return (
            // every tile keeps its control, so choosing one never changes the layout (§7.2)
            <div
              key={o}
              role="radio"
              aria-checked={choice.option === o}
              tabIndex={0}
              class={`dl-tile${choice.option === o ? " on" : ""}${t.count ? "" : " empty"}`}
              style={{ "--h": TILE_HUE[o] }}
              onClick={() => choice.option !== o && choose({ option: o })}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && e.target === e.currentTarget && (e.preventDefault(), choose({ option: o }))}
            >
              <span class="dl-tn">{OPT_LABEL[o]}</span>
              <span class="dl-tc">{t.count}</span>
              <span class="dl-ts">
                <span>{line.size}</span>
                {line.time && <span>{line.time}</span>}
              </span>
              <span class="dl-tx">
                <TileControl o={o} plan={plan} />
              </span>
            </div>
          );
        })}
      </div>
      <div class="dl-line">
        <span class="seg dl-seg" role="radiogroup" aria-label="Quality">
          {QUALITIES.map(({ q, label }) => (
            <button key={q} role="radio" aria-checked={choice.quality === q} class={choice.quality === q ? "on" : ""} onClick={() => choose({ quality: q })}>
              {label}
            </button>
          ))}
        </span>
        <Destination plan={plan} />
      </div>
      {hasInstagram(chosen) && <InstagramRow />}
      {/* the list is the plan's: while the next plan is on its way, the last one stays (no flash of the wrong list) */}
      <div class="dl-listwrap">
        {plan.option === "full" ? (
          <div class="dl-fade dl-fullnote" key="full">
            <b>All {nVideos(plan.options.full.count)} not on this machine</b>
            <span class="dim">No picking: the whole archive goes in the queue, 2 at a time. Close this window and it keeps going.</span>
          </div>
        ) : (
          <div class="dl-fade" key={plan.option}>
            <div class="dl-listhead">
              <label>
                <input type="checkbox" checked={all === "all"} ref={(el) => void (el && (el.indeterminate = all === "some"))} disabled={!plan.videos.length} onChange={() => setExcluded(all === "all" ? plan.videos.map((v) => v.id) : [])} />
                <span>{all === "all" ? "Deselect all" : "Select all"}</span>
              </label>
              <span class="dim">
                {chosen.length} of {plan.videos.length} picked
              </span>
              <span class="dl-cols dim">
                <span>Length</span>
                <span>Size</span>
              </span>
            </div>
            {plan.videos.length ? (
              <ul class="dl-list">
                {plan.videos.map((v) => (
                  <li key={v.id} class={choice.excluded.has(v.id) ? "off" : ""}>
                    <label>
                      <input type="checkbox" checked={!choice.excluded.has(v.id)} onChange={() => toggleVideo(v.id)} />
                      <Poster video={{ id: v.id, thumbnail: v.posterUrl ? ({ poster: v.posterUrl } as never) : null, available: true, durationS: null }} />
                      <span class="dl-t">
                        {v.title}
                        <small class="dim">{v.artists.join(", ") || v.source}</small>
                      </span>
                      <span class="mono dl-len">{fmtLen(v.durationS)}</span>
                      <span class="mono dl-size">{v.estBytes == null ? "–" : fmtBytes(v.estBytes)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : (
              <div class="dl-empty dim">Nothing to download here.</div>
            )}
          </div>
        )}
      </div>
      <footer class="dl-sticky">
        <span class={tooSmall ? "dl-warn" : "dim"}>
          {plan.freeBytes == null ? "free space unknown" : `${fmtBytes(plan.freeBytes)} free`}
          {tooSmall ? " — not enough" : ""}
        </span>
        <span class="dl-notes dim">
          {totals.withoutEstimate > 0 && <span>+ {totals.withoutEstimate} without an estimate</span>}
          {plan.totals.throughputAssumed && totals.count > 0 && <span title="No download has finished yet, so 2 MB/s is assumed">speed assumed</span>}
        </span>
        <button class="btn primary big" disabled={!!block} title={block ?? undefined} onClick={() => void confirm()}>
          {confirmLabel(totals)}
        </button>
      </footer>
    </>
  );
}

function Destination({ plan }: { plan: PlanResponse }) {
  const { choice } = useDownloads();
  const dir = plan.destDir;
  return (
    <div class="dl-dest">
      <span class="dim">Into</span>{" "}
      {dir ? (
        <span class="mono dl-path" title={dir}>
          {choice.destDir == null ? `Root ${dir.split("/").filter(Boolean).pop() ?? dir}` : dir}
        </span>
      ) : (
        <span class="dl-warn">no Root is mounted</span>
      )}
      <button class="btn small" onClick={() => void chooseFolder()}>
        Change…
      </button>
      {choice.destDir != null && (
        <button class="btn small" onClick={() => choose({ destDir: null })}>
          Back to Root
        </button>
      )}
      {dir && !plan.destInRoot && <div class="dl-warn">Videos downloaded here won't appear in the library.</div>}
    </div>
  );
}

// ---- the Instagram row (§5.2–5.3) -----------------------------------------------------------------------------------

function InstagramRow() {
  const { settings, igEditing, igError } = useDownloads();
  const [browser, setBrowser] = useState<Browser>("firefox");
  if (!settings) return null;
  const a = settings.instagramAuth;
  const status = instagramStatus(a);
  const note = browserNote(browser, settings.platform);
  return (
    <div class={`dl-ig${igEditing ? " open" : ""}`}>
      <div class="dl-igline">
        <span class="dl-ign">Instagram</span>
        <span class={a.kind === "none" ? "dim" : ""}>{status.text}</span>
        {status.expired && <b class="dl-bad">expired</b>}
        <button class="linkbtn" aria-expanded={igEditing} onClick={() => editInstagram(!igEditing)}>
          {igEditing ? "Done" : "Change…"}
        </button>
        {!igEditing && a.kind === "none" && <span class="dim dl-ighint">Tried signed out first; cookies help only with Videos behind the login wall.</span>}
      </div>
      {igEditing && (
        <div class="dl-igedit">
          {!settings.noticeAckAt ? (
            // §5.3: one time, before cookies can be set at all
            <div class="dl-ignotice" role="alert">
              <b>Before you give TuvaVideos Instagram cookies</b>
              <ul>
                {INSTAGRAM_NOTICE.map((l) => (
                  <li key={l}>{l}</li>
                ))}
              </ul>
              <div>
                <button class="btn small primary" onClick={() => void acknowledgeInstagramNotice()}>
                  I understand
                </button>
              </div>
            </div>
          ) : (
            <>
              <div class="dl-igopt">
                <button class="btn small" onClick={() => void chooseCookiesFile()}>
                  {a.kind === "file" ? "Replace cookies.txt…" : "Choose cookies.txt…"}
                </button>
                <span class="dl-rec">recommended</span>
                <span class="dim">Export it (Netscape format) from a throwaway account in a browser profile of its own. It is copied; the original can go.</span>
              </div>
              <div class="dl-igopt">
                <select aria-label="Browser" value={browser} onChange={(e) => setBrowser((e.target as HTMLSelectElement).value as Browser)}>
                  {settings.browsers.map((b) => (
                    <option key={b} value={b}>
                      {BROWSER_LABEL[b]}
                    </option>
                  ))}
                </select>
                <button class="btn small" onClick={() => void setInstagramAuth({ kind: "browser", browser })}>
                  Use this browser's cookies
                </button>
                {note && <span class="dim">{note}</span>}
              </div>
              {a.kind !== "none" && (
                <div class="dl-igopt">
                  <button class="btn small" onClick={() => void setInstagramAuth({ kind: "none" })}>
                    Sign out
                  </button>
                  {a.kind === "file" && <span class="dim">deletes the copied cookies.txt</span>}
                </div>
              )}
            </>
          )}
          {igError && <div class="dl-bad">{igError}</div>}
        </div>
      )}
    </div>
  );
}

// ---- the log (§7.3) ------------------------------------------------------------------------------------------------

function Speed({ bps }: { bps: number }) {
  return <span class={`dl-speed ${paceOf(bps)}`}>{fmtSpeed(bps)}</span>;
}

function Bar({ pct, thin }: { pct: number; thin?: boolean }) {
  return (
    <div class={`dl-bar${thin ? " thin" : ""}`} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

function Row({ it }: { it: ItemDto }) {
  const g = rowGroup(it.state);
  const size = it.exactBytes ?? it.estBytes;
  let sub: ComponentChildren;
  if (g === "running") {
    const done = it.doneBytes ?? 0;
    const left = size != null && it.speedBps ? (size - done) / it.speedBps : (it.etaS ?? 0);
    sub =
      it.state === "downloading" ? (
        <>
          {fmtBytes(done)}
          {size != null && size >= done ? ` of ~${fmtBytes(size)}` : ""}
          {left > 0 ? ` ~${fmtDur(left)}` : ""}
          {it.speedBps ? (
            <>
              {" "}
              · <Speed bps={it.speedBps} />
            </>
          ) : null}
        </>
      ) : (
        it.state // sizing, merging, scanning
      );
  } else if (g === "failed") sub = reasonWords(it.reason);
  else if (it.state === "waiting") sub = `waiting: ${reasonWords(it.reason)}`;
  else if (it.state === "done_outside") sub = "done (outside the library)";
  else if (it.state === "skipped") sub = "already on this machine";
  else if (g === "cancelled") sub = "cancelled";
  else sub = size != null ? `~${fmtBytes(size)}` : "";
  return (
    <li class={`dl-row ${g}`}>
      <span class="dl-ic" aria-hidden="true">
        {ROW_MARK[g]}
      </span>
      <span class="dl-t">
        {it.title}
        <small>{sub}</small>
      </span>
      <span class="dl-rowend">
        {g === "running" && size ? <Bar pct={((it.doneBytes ?? 0) / size) * 100} thin /> : null}
        {isLive(it.state) && (
          <button class="dl-rx" aria-label={`Cancel ${it.title}`} title="Cancel this Video" onClick={() => void cancelItem(it.id)}>
            ×
          </button>
        )}
      </span>
    </li>
  );
}

function Terminal({ lines }: { lines: string[] }) {
  const el = useRef<HTMLPreElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (el.current && stick.current) el.current.scrollTop = el.current.scrollHeight;
  });
  return (
    <pre
      class="dl-term"
      ref={el}
      onScroll={(e) => {
        const p = e.currentTarget;
        stick.current = p.scrollHeight - p.scrollTop - p.clientHeight < 30;
      }}
    >
      {lines.length ? (
        lines.map((l, i) => (
          <div key={i}>
            {colorLine(displayLine(l)).map((sp, k) => (sp.tone ? <span key={k} class={`t-${sp.tone}`}>{sp.text}</span> : sp.text))}
          </div>
        ))
      ) : (
        <div class="dim">No output yet.</div>
      )}
    </pre>
  );
}

function Log() {
  const s = useDownloads();
  const [showTerm, setShowTerm] = useState(false);
  const job: JobDto | null = s.snap?.job ?? null;
  if (!s.snap) return <div class="dl-empty dim">Reading the queue…</div>;
  if (!job)
    return (
      <div class="dl-empty">
        <span class="dim">That download is no longer kept.</span>
        <button class="btn small" onClick={newDownload}>
          New download
        </button>
      </div>
    );
  const h = headline(job.counts, job.doneBytes, job.totalBytes);
  const held = job.running ? heldStatus(s.snap, Date.now()) : null;
  const left = Math.max(0, job.totalBytes - job.doneBytes);
  const eta = job.speedBps > 0 ? left / job.speedBps : 0;
  const notStarted = job.running && !s.snap.started && !!s.snap.resumePrompt;
  return (
    <>
      <div class="dl-big">
        <span class="dl-pct">
          {Math.floor(h.pct)}
          <small>%</small>
        </span>
        <span>
          <b>
            {h.done} of {h.of}
          </b>{" "}
          downloaded{h.failed ? <span class="dl-bad"> · {h.failed} failed</span> : null}
          {job.counts.cancelled ? <span class="dim"> · {job.counts.cancelled} cancelled</span> : null}
          <br />
          <span class="dim">
            {fmtBytes(job.doneBytes)} of {fmtBytes(job.totalBytes)}
            {job.running && eta > 0 ? ` ~${fmtDur(eta)}` : ""}
          </span>
          {job.running && (
            <>
              {" "}
              <span class="dim">·</span>{" "}
              {held ? <span class="dl-held">{held}</span> : notStarted ? <span class="dl-held">Not resumed yet</span> : job.speedBps > 0 ? <Speed bps={job.speedBps} /> : <span class="dim">starting…</span>}
            </>
          )}
          {!job.running && <span class="dim"> · {job.cancelledAt ? "cancelled" : "finished"}</span>}
        </span>
      </div>
      <Bar pct={h.pct} />
      <ul class={`dl-rows${showTerm ? " short" : ""}`}>
        {sortRows(s.snap.items).map((it) => (
          <Row key={it.id} it={it} />
        ))}
      </ul>
      <button class={`dl-termbtn${showTerm ? " open" : ""}`} aria-expanded={showTerm} onClick={() => setShowTerm(!showTerm)}>
        {TERM_ICON}
        <span>{showTerm ? "Hide" : "Show"} yt-dlp output</span>
        <span class="dim dl-termn">
          {s.lines.length} line{s.lines.length === 1 ? "" : "s"} · {s.errors} error{s.errors === 1 ? "" : "s"}
        </span>
      </button>
      {showTerm && <Terminal lines={s.lines} />}
      <footer class="dl-foot">
        {s.snap.paused || s.snap.diskFull || notStarted ? (
          <button class="btn small" onClick={() => void resumeQueue()} disabled={!job.running || !!s.snap.resumePrompt?.waitingForRoot}>
            Resume
          </button>
        ) : (
          <button class="btn small" onClick={() => void pauseQueue()} disabled={!job.running}>
            Pause
          </button>
        )}
        <button class="btn small" onClick={() => confirm(`Cancel this download? ${nVideos(job.counts.queued + job.counts.waiting + job.counts.running)} not downloaded yet are dropped, with their partial files.`) && void cancelJob(job.id)} disabled={!job.running}>
          Cancel
        </button>
        {h.failed > 0 && (
          <>
            <a class="btn small" href={reportUrl(job.id)} download>
              Save failure report (.txt)
            </a>
            <button class="btn small" onClick={() => void retryFailed(job.id)}>
              Retry failed ({h.failed})
            </button>
          </>
        )}
        {!job.running && (
          <button class="btn small primary dl-new" onClick={newDownload}>
            New download
          </button>
        )}
      </footer>
    </>
  );
}
