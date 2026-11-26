// A Live stream in the desktop Player (home-server-spec 7.1, 7.2): the browser's own HLS when the element answers
// `canPlayType('application/vnd.apple.mpegurl')`, else hls.js, bundled into app.js (no CDN). The light build: no
// subtitles, alternate audio or DRM, none of which a Live stream has. The worker is off, so nothing is fetched
// from a blob URL or a separate file; one stream's transmuxing on the main thread is light.
import Hls from "hls.js/light";
import { hlsMode } from "../shared/liveQuality";

export interface LiveSource {
  /** "native" or "hlsjs": how it plays. */
  readonly mode: "native" | "hlsjs";
  /** Stops hls.js and lets go of the element (a native one is reset by the caller, as for a file). */
  detach(): void;
}

/**
 * Plays the HLS playlist `url` in `v` from `startS`. `onFatal` is hls.js giving up (its media element raises no
 * `error` for a failed segment); a native one fails through the element's `error` event as a file does. Null: this
 * browser plays HLS neither way.
 */
export function attachLive(v: HTMLVideoElement, url: string, startS: number, onFatal: (status: number | null) => void): LiveSource | null {
  const mode = hlsMode(v.canPlayType("application/vnd.apple.mpegurl"), Hls.isSupported());
  if (mode === "native") {
    v.src = url;
    v.load();
    return { mode, detach() {} };
  }
  if (mode !== "hlsjs") return null;
  const hls = new Hls({
    enableWorker: false,
    startPosition: startS > 0 ? startS : -1, // the first segment asked for is the one at the start position: no encoder restart
    maxBufferLength: 30, // the server encodes about 60 s ahead and pauses: ask for no more than it keeps
    backBufferLength: 60,
  });
  let dead = false;
  hls.on(Hls.Events.ERROR, (_e, d) => {
    if (!d.fatal || dead) return;
    dead = true;
    onFatal(d.response?.code ?? null);
  });
  hls.loadSource(url);
  hls.attachMedia(v);
  return {
    mode,
    detach() {
      dead = true;
      hls.destroy();
    },
  };
}
