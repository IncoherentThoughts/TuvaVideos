// Stub for /play/:videoId[?t=]: the Player is ticket #24. It shows enough to verify routing and the `t` parameter.
import { useEffect, useState } from "preact/hooks";
import type { VideoDto } from "../shared/types";
import { api, setLastPlayed, toggleFavorite } from "./data";
import { Link } from "./router";
import { AvailabilityIcon, FavoriteBadge, Poster, Tags, fmtDuration } from "./ui";

export function Play({ videoId, t }: { videoId: number; t: number | null }) {
  const [v, setV] = useState<VideoDto | null | undefined>(undefined);
  useEffect(() => {
    setLastPlayed(videoId);
    let alive = true;
    api.video(videoId).then((r) => alive && setV(r)).catch(() => alive && setV(null));
    return () => {
      alive = false;
    };
  }, [videoId]);

  return (
    <div class="stub">
      {v === undefined && <p>Loading…</p>}
      {v === null && <h1>No such Video</h1>}
      {v && (
        <>
          <div style={{ maxWidth: "480px", marginBottom: "16px" }}>
            <Poster video={v} dur edge />
          </div>
          <h1>
            {v.favoritedAt && <FavoriteBadge />}
            {v.title}
          </h1>
          <div style={{ display: "flex", gap: "10px", alignItems: "center" }}>
            <AvailabilityIcon availability={v.availability} />
            <Tags video={v} />
            <span class="mono muted">{fmtDuration(v.durationS)}</span>
          </div>
          <p>
            Video #{v.id}
            {t != null && <> · opens at <span class="mono">{fmtDuration(t)}</span> (t={t})</>}
          </p>
          <p>The Player arrives with ticket #24. This page only proves the route.</p>
          <p style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
            <button class="btn" onClick={() => void toggleFavorite("video", v.id).then(() => api.video(v.id).then(setV))}>
              {v.favoritedAt ? "Remove Favorite" : "Add Favorite"}
            </button>
            <Link href="/" class="btn">Back to Library</Link>
          </p>
        </>
      )}
    </div>
  );
}
