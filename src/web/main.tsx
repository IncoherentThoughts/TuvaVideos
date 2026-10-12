import { render } from "preact";
import { Artists } from "./Artists";
import { Favorites } from "./Favorites";
import { Library } from "./Library";
import { LyricsPage } from "./LyricsPage";
import { Play } from "./Play";
import { SearchResults } from "./SearchResults";
import { Songs } from "./Songs";
import { TopBar } from "./TopBar";
import { VideoMenu } from "./VideoMenu";
import { loadArtists, loadVideos, useStore } from "./data";
import { installKeys } from "./keys";
import { matchRoute, useLocation } from "./router";

function App() {
  const loc = useLocation();
  const route = matchRoute(loc);
  const { error } = useStore();
  return (
    <>
      <TopBar route={route} />
      <VideoMenu />
      <main>
        {error && <div class="empty-state">Server problem: {error}</div>}
        {route.name === "library" && <Library search={loc.search} />}
        {route.name === "favorites" && <Favorites search={loc.search} />}
        {route.name === "artists" && <Artists search={loc.search} />}
        {route.name === "songs" && <Songs search={loc.search} />}
        {route.name === "search" && <SearchResults q={route.q} sort={route.sort} />}
        {route.name === "play" && <Play videoId={route.videoId} t={route.t} lyrics={route.lyrics} lyricsVersion={route.lyricsVersion} />}
        {route.name === "lyrics" && <LyricsPage songId={route.songId} />}
        {route.name === "notfound" && <div class="empty-state">No such page.</div>}
      </main>
    </>
  );
}

installKeys();
void loadVideos();
void loadArtists();
render(<App />, document.getElementById("app")!);
