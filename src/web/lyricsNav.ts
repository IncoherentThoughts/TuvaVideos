// Choosing a Song (or a Track with a Song) in the search dropdown opens its lyrics (spec 6.2):
//  1. the current Now playing Video performs the Song -> open the drawer here;
//  2. else the first Video that does (its Song pointer, else a Performance with its YouTube id; playable first) ->
//     Now playing on that Video, drawer open;
//  3. else (no Video performs it) -> /lyrics/:songId, the Reader on a page of its own, no Video.
import { api, currentVideos } from "./data";
import { navigate, PLAY_PATH, playHref } from "./router";

export async function openLyrics(songId: string, versionId: string | null = null): Promise<void> {
  const here = PLAY_PATH.exec(location.pathname);
  const cur = here ? here[1]! : null;
  const song = await api.song(songId).catch(() => null);
  if (!song) return void navigate(`/lyrics/${songId}`);
  const lyrics = { songId, versionId };
  const keepT = new URLSearchParams(location.search).get("t");
  if (cur != null) {
    const v = currentVideos()?.find((x) => x.id === cur);
    if (v?.songId === songId || song.videos.some((x) => x.id === cur)) {
      return void navigate(playHref(cur, keepT ? Number(keepT) : null, lyrics), { replace: true });
    }
  }
  const first = song.videos[0];
  if (first) {
    const at = first.startS && first.startS > 0 ? first.startS : null; // a concert Performance carries its offset
    return void navigate(playHref(first.id, at, lyrics));
  }
  navigate(`/lyrics/${songId}`);
}
