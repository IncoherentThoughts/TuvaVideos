// The two per-machine switches of the Library Server menu (docs/home-server-spec.md §2.2): Serve on launch, and Open at login
// (a LaunchAgent that starts the app at login with no tab; only offered while Serve on launch is on).
import { useEffect, useState } from "preact/hooks";
import type { ServeSettingsDto } from "../shared/types";
import { api, apiError } from "./data";

export function ServeSettings() {
  const [s, setS] = useState<ServeSettingsDto | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.serveSettings().then(setS, () => {});
  }, []);
  if (!s?.available) return null;
  const set = async (p: { serveOnLaunch?: boolean; openAtLogin?: boolean }) => {
    setBusy(true);
    try {
      setS(await api.setServeSettings(p));
    } catch (e) {
      alert(`Library Server: ${apiError(e)}`);
    }
    setBusy(false);
  };
  return (
    <>
      <div class="tvhd">This Mac</div>
      <label class="tvrow">
        <span>
          <input type="checkbox" checked={s.serveOnLaunch} disabled={busy} onChange={(e) => void set({ serveOnLaunch: e.currentTarget.checked })} /> Serve on launch
        </span>
      </label>
      <label class="tvrow" title={s.serveOnLaunch ? "Starts TuvaVideos at login, without opening a tab" : "Turn Serve on launch on first"}>
        <span>
          <input type="checkbox" checked={s.openAtLogin} disabled={busy || !s.serveOnLaunch} onChange={(e) => void set({ openAtLogin: e.currentTarget.checked })} /> Open at login
        </span>
      </label>
      {s.serveOnLaunch && <div class="tvtip">While serving, this Mac stays awake (no idle sleep).</div>}
    </>
  );
}
