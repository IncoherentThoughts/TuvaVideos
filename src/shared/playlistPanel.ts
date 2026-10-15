// The Playlist panel's pure parts (spec 4.8 "Panel"): which rows it lists and when "show played" resets.
import { played, upcoming, type Playlist } from "./playlist";

export type PanelRowKind = "played" | "current" | "upcoming";
export interface PanelRow {
  kind: PanelRowKind;
  /** Index into `pl.entries`. */
  entryIndex: number;
}

/** Rows top to bottom: Played in the order they were played (only with "show played"), the current Entry, then upcoming in Play order. */
export function panelRows(pl: Playlist, showPlayed: boolean): PanelRow[] {
  const rows: PanelRow[] = showPlayed ? played(pl).map((entryIndex) => ({ kind: "played", entryIndex })) : [];
  const cur = pl.order[pl.cursor];
  if (cur !== undefined) rows.push({ kind: "current", entryIndex: cur });
  for (const entryIndex of upcoming(pl)) rows.push({ kind: "upcoming", entryIndex });
  return rows;
}

/** "show played" is remembered with the Playlist start (`gen`) it was set under: a new Playlist reads it as off. */
export interface ShowPlayed {
  gen: number;
  on: boolean;
}
export const showPlayedFor = (s: ShowPlayed, gen: number): boolean => s.on && s.gen === gen;
export const toggleShowPlayed = (s: ShowPlayed, gen: number): ShowPlayed => ({ gen, on: !showPlayedFor(s, gen) });
