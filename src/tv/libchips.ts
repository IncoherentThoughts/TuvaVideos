// The Library chips (docs/tv-spec.md 5.2): Type, Favorites, Sort and direction, each cycled with Enter. Pure.
// The browser app's own filter and sort live in its URL, which the TV cannot read; these live in memory.
import { TYPES } from "../shared/filters"
import { SORTS, defaultDir, type LibraryState } from "../shared/libraryView"

export type ChipId = "type" | "fav" | "sort" | "dir"
export const CHIPS: readonly ChipId[] = ["type", "fav", "sort", "dir"]

export const SORT_LABEL: Record<(typeof SORTS)[number], string> = { views: "Most watched", added: "Date added", title: "Title", duration: "Duration", played: "Last played" }

export function chipLabel(id: ChipId, st: LibraryState): { name: string; value: string; on: boolean } {
  switch (id) {
    case "type": return { name: "Type", value: st.types[0] ?? "all", on: st.types.length > 0 }
    case "fav": return { name: "Favorites", value: st.fav ? "only" : "all", on: st.fav }
    case "sort": return { name: "Sort", value: SORT_LABEL[st.sort], on: st.sort !== "views" }
    case "dir": return { name: "Order", value: st.dir === "asc" ? "ascending" : "descending", on: st.dir !== defaultDir(st.sort) }
  }
}

/** Enter on a chip: Type walks all -> song -> concert -> interview -> other -> all; the others flip or advance. */
export function cycleChip(id: ChipId, st: LibraryState): LibraryState {
  switch (id) {
    case "type": {
      const i = st.types.length ? TYPES.indexOf(st.types[0]!) + 1 : 0
      return { ...st, types: i >= TYPES.length ? [] : [TYPES[i]!] }
    }
    case "fav": return { ...st, fav: !st.fav }
    case "sort": {
      const sort = SORTS[(SORTS.indexOf(st.sort) + 1) % SORTS.length]!
      return { ...st, sort, dir: defaultDir(sort) } // a new sort starts in its natural direction
    }
    case "dir": return { ...st, dir: st.dir === "asc" ? "desc" : "asc" }
  }
}
