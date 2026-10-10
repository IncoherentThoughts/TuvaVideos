import { useEffect, useRef, useState } from "preact/hooks";
import type { ScanDto } from "../shared/types";
import { SearchBox } from "./SearchBox";
import { api, getLastPlayed, reloadAll, useStore } from "./data";
import { Link, type Route } from "./router";

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
  useStore(); // re-render when the last-played Video changes
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

  const last = route.name === "play" ? route.videoId : getLastPlayed();
  const tab = (name: Route["name"], href: string | null, label: string) => (
    <Link href={href ?? "/"} class={`tab${route.name === name ? " on" : ""}${href === null ? " off" : ""}`} aria-current={route.name === name ? "page" : undefined} tabIndex={href === null ? -1 : undefined}>
      {label}
    </Link>
  );

  return (
    <header class="topbar">
      <Link href="/" class="brand" aria-label="TuvaVideos">
        <svg viewBox="0 0 32 32" width="18" height="18" aria-hidden="true">
          <path d="M16 5 L26 16 L16 27 L6 16 Z" fill="none" stroke="#1a0f0a" stroke-width="3.2" stroke-linejoin="round" />
        </svg>
      </Link>
      <nav class="tabs">
        {tab("library", "/", "Library")}
        {tab("play", last != null ? `/play/${last}` : null, "Now playing")}
        {tab("favorites", "/favorites", "Favorites")}
        {tab("artists", "/artists", "Artists")}
      </nav>
      <div class="topright">
        {scan && <ScanIndicator scan={scan} />}
        <SearchBox />
        <button class="btn" onClick={rescan} disabled={busy || !!scan?.running} title="Scan the Roots for new files">
          Rescan
        </button>
      </div>
    </header>
  );
}
