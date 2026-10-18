import { useEffect, useRef, useState } from "preact/hooks";
import type { ScanDto } from "../shared/types";
import { SearchBox } from "./SearchBox";
import { api, apiError, getLastPlayed, playRandom, reloadAll, useStore } from "./data";
import { TvButton } from "./TvButton";
import { AccountChip } from "./Account";
import { Link, type Route } from "./router";
import { THEMES, useTheme } from "./theme";

function ScanIndicator({ scan }: { scan: ScanDto }) {
  if (!scan.running) return null;
  const pct = scan.filesToProbe > 0 ? Math.round((scan.filesProbed / scan.filesToProbe) * 100) : null;
  const label =
    scan.phase === "walking" ? `scanning… ${scan.filesSeen} files`
    : scan.phase === "probing" ? `probing ${scan.filesProbed}/${scan.filesToProbe}`
    : "finishing…";
  return (
    <span class="scan" role="status" title="Scanning the Roots for new files">
      {label}
      {pct !== null && (
        <span class="bar">
          <i style={{ width: `${pct}%` }} />
        </span>
      )}
    </span>
  );
}

export function TopBar({ route }: { route: Route }) {
  const { videos } = useStore(); // re-render when the last-played Video changes
  const anyAvailable = !!videos?.some((v) => v.available);
  const [scan, setScan] = useState<ScanDto | null>(null);
  const [busy, setBusy] = useState(false);
  const wasRunning = useRef(false);

  // Poll GET /api/scan: quickly while a scan runs, lazily otherwise. A scan that just finished reloads the library.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let next = 4000;
      try {
        const s = await api.scan();
        if (!alive) return;
        setScan(s);
        if (s.running) next = 1000;
        if (wasRunning.current && !s.running) void reloadAll();
        wasRunning.current = s.running;
      } catch {}
      if (alive) timer = setTimeout(tick, next);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const rescan = async () => {
    setBusy(true);
    try {
      await api.rescan();
      const s = await api.scan();
      setScan(s);
      wasRunning.current = s.running || wasRunning.current;
    } catch {}
    setBusy(false);
  };

  // Power button: stop the server, then close the tab. Chrome only lets a page close itself when it has a short history,
  // so when the tab stays open the shell is replaced by a plain "off" page instead of a dead app.
  const [off, setOff] = useState(false);
  const powerOff = async () => {
    setBusy(true);
    try {
      await api.quit();
    } catch (e) {
      setBusy(false);
      alert(`Could not stop the server: ${apiError(e)}`);
      return;
    }
    setOff(true);
    window.close();
  };

  const [theme, setTheme] = useTheme();
  const last = route.name === "play" ? route.videoId : getLastPlayed();
  const tab = (name: Route["name"], href: string | null, label: string) => (
    <Link href={href ?? "/"} class={`tab${route.name === name ? " on" : ""}${href === null ? " off" : ""}`} aria-current={route.name === name ? "page" : undefined} tabIndex={href === null ? -1 : undefined}>
      {label}
    </Link>
  );

  return (
    <header class="topbar">
      <Link href="/" class="brand" aria-label="TuvaVideos">
        <img src="/olchey.svg?v=2" alt="" width="28" height="28" />
      </Link>
      <nav class="tabs">
        {tab("play", last != null ? `/play/${last}` : null, "Now playing")}
        {tab("library", "/", "Library")}
        {tab("songs", "/songs", "Songs")}
        {tab("artists", "/artists", "Artists")}
        {tab("favorites", "/favorites", "Favorites")}
      </nav>
      <div class="topright">
        {scan && <ScanIndicator scan={scan} />}
        <SearchBox />
        <button class="btn" onClick={() => playRandom()} disabled={!anyAvailable} title="Play a random available Video (r)">
          Random
        </button>
        <select class="btn theme" aria-label="Theme" title="Theme (docs/themes.md)" value={theme} onChange={(e) => setTheme((e.target as HTMLSelectElement).value)}>
          {THEMES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
        <TvButton />
        <button class="btn" onClick={rescan} disabled={busy || !!scan?.running} title="Scan the Roots for new files">
          Rescan
        </button>
        <button class="btn power" onClick={powerOff} disabled={busy} title="Stop TuvaVideos and close this tab" aria-label="Stop TuvaVideos and close this tab">
          <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
            <path d="M8 1.5v6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <path d="M4.9 3.9a5.2 5.2 0 1 0 6.2 0" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
          </svg>
        </button>
        <AccountChip />
      </div>
      {off && (
        <div class="off-page" role="status">
          <img src="/olchey.svg?v=2" alt="" width="64" height="64" />
          <p>TuvaVideos is off. You can close this tab.</p>
        </div>
      )}
    </header>
  );
}
