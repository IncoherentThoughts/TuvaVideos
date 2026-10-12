// /lyrics/:songId: the Reader on a page of its own, for a Song no Video performs (spec 6.2 leaves this case open; kept
// simple: the same Reader, plus the Videos that do perform it when there are any).
import { useEffect, useState } from "preact/hooks";
import type { SongDto } from "../shared/types";
import { LyricsReader } from "./Lyrics";
import { api, apiError } from "./data";
import { Link, navigate, playHref } from "./router";

export function LyricsPage({ songId }: { songId: string }) {
  const [song, setSong] = useState<SongDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => void api.song(songId).then(setSong).catch(() => setSong(null)), [songId]);
  const del = async () => {
    try {
      await api.deleteSong(songId);
      navigate("/songs");
    } catch (e) {
      setErr(apiError(e));
      setConfirm(false);
    }
  };
  return (
    <div class="page lyrics-page">
      <p class="muted">
        {song?.local ? "A local Song: created in this library, not in the archive. " : ""}
        {song && song.videos.length === 0 ? "No Video in your library performs this Song." : song?.local ? "" : "Lyrics from the archive Mirror."}
        {song?.local && song.videos.length === 0 && !confirm && (
          <>
            {" "}
            <button class="linkbtn" onClick={() => setConfirm(true)}>Delete this local Song…</button>
          </>
        )}
        {confirm && (
          <>
            {" "}Delete it and its local lyrics?{" "}
            <button class="btn small danger" onClick={() => void del()}>Delete</button>{" "}
            <button class="btn small" onClick={() => setConfirm(false)}>Keep</button>
          </>
        )}
      </p>
      {err && <p class="edit-err" role="alert">{err}</p>}
      <LyricsReader songId={songId} versionId={null} autoFocus />
      {song && song.videos.length > 0 && (
        <ul class="song-videos">
          {song.videos.map((v) => (
            <li key={v.id}>
              <Link href={playHref(v.id, v.startS)}>{v.title}</Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
