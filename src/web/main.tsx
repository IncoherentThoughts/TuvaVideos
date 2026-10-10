import { render } from "preact";
import { Artists } from "./Artists";
import { Favorites } from "./Favorites";
import { Library } from "./Library";
import { Play } from "./Play";
import { TopBar } from "./TopBar";
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
      <main>
        {error && <div class="empty-state">Server problem: {error}</div>}
        {route.name === "library" && <Library search={loc.search} />}
        {route.name === "favorites" && <Favorites search={loc.search} />}
        {route.name === "artists" && <Artists />}
        {route.name === "play" && <Play videoId={route.videoId} t={route.t} />}
        {route.name === "notfound" && <div class="empty-state">No such page.</div>}
      </main>
    </>
  );
}

installKeys();
void loadVideos();
void loadArtists();
render(<App />, document.getElementById("app")!);
