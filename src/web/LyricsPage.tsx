// /lyrics/:songId: the Reader on a page of its own, for a Song no Video performs (spec 6.2 leaves this case open; kept
// simple: the same Reader, plus the Videos that do perform it when there are any).
import { useEffect, useState } from "preact/hooks";
import type { SongDto } from "../shared/types";
import { LyricsReader } from "./Lyrics";
import { api } from "./data";
import { Link, playHref } from "./router";

export function LyricsPage({ songId }: { songId: string }) {
  const [song, setSong] = useState<SongDto | null>(null);
  useEffect(() => void api.song(songId).then(setSong).catch(() => setSong(null)), [songId]);
  return (
    <div class="page lyrics-page">
      <p class="muted">{song && song.videos.length === 0 ? "No Video in your library performs this Song." : "Lyrics from the archive Mirror."}</p>
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
