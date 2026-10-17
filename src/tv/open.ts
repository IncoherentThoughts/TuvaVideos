// What Enter does on a tile (docs/tv-spec.md 5.3, 5.4). Shared by the home rails and the grids.
import type { PlayingSource } from "../shared/playingFrom"
import type { Nav } from "./screen"
import { playingFromTiles, railGrid, type Tile } from "./rails"
import { tagGrid, type TagItem } from "./tags"

/**
 * Open `tile`: a Video or Chapter plays (Playing from = `list`, the grid or rail it sits in, snapshotted now), an
 * Artist or Song opens the grid of its Videos, See all opens the rail's full grid.
 */
export function openTile(tile: Tile, nav: Nav, list: readonly Tile[], source: PlayingSource = "library"): void {
  switch (tile.kind) {
    case "video":
      if (!tile.video.available) return nav.toast("No Copy of this Video is mounted")
      return nav.play(tile.video.id, { startS: tile.startS ?? null, playingFrom: playingFromTiles(list, source) })
    case "chapter":
      if (!tile.video.available) return nav.toast("No Copy of this Video is mounted")
      return nav.play(tile.video.id, { startS: tile.chapter.startS, playingFrom: playingFromTiles(list, source) })
    case "artist":
      return nav.openGrid({ kind: "artist", id: tile.artist.id, name: tile.artist.name })
    case "song":
      return nav.openGrid({ kind: "song", id: tile.song.id, name: tile.song.name })
    case "all":
      return nav.openGrid(railGrid(tile.rail))
    case "shuffle":
      return
  }
}

/** Enter on a tag in the Player's tag row (docs/tv-spec.md 6.4): the grid of that Type / Artist / Song's Videos replaces the Player. */
export function openTag(tag: TagItem, nav: Pick<Nav, "swapToGrid">): void {
  nav.swapToGrid(tagGrid(tag))
}
