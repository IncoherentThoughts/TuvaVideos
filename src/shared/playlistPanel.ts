// The Playlist panel's pure parts (spec 4.8 "Panel"): which rows it lists and when "show played" resets.
import type { Playlist } from "./playlist";

export type PanelRowKind = "played" | "current" | "upcoming";
export interface PanelRow {
  kind: PanelRowKind;
  /** Index into `pl.entries`. */
  entryIndex: number;
}

/** Rows top to bottom: Played in the order they were played (only with "show played"), the current Entry, then upcoming in Play order. */
export function panelRows(pl: Playlist, showPlayed: boolean): PanelRow[] {
  return panelWindow(pl, showPlayed, pl.order.length, pl.order.length).rows;
}

export interface PanelWindow {
  rows: PanelRow[];
  /** Played rows above the window (only with "show played"). */
  hiddenPlayed: number;
  /** Upcoming rows below the window. */
  hiddenUpcoming: number;
}

/**
 * The rows to render (spec 4.8 "Panel": windowed, the current row always in). Cost is O(rows shown), never O(Playlist):
 * `upcomingLimit` upcoming rows below the current one and, with "show played", the last `playedLimit` Played rows above it
 * (the window grows upward from the current row, so a 2000-row history is never rendered at once).
 */
export function panelWindow(pl: Playlist, showPlayed: boolean, upcomingLimit: number, playedLimit: number): PanelWindow {
  const rows: PanelRow[] = [];
  const cur = pl.cursor;
  const len = pl.order.length;
  let hiddenPlayed = 0;
  if (showPlayed) {
    const from = Math.max(0, Math.min(cur, len) - playedLimit);
    hiddenPlayed = from;
    for (let i = from; i < Math.min(cur, len); i++) rows.push({ kind: "played", entryIndex: pl.order[i]! });
  }
  if (pl.order[cur] !== undefined) rows.push({ kind: "current", entryIndex: pl.order[cur]! });
  const to = Math.min(len, cur + 1 + upcomingLimit);
  for (let i = cur + 1; i < to; i++) rows.push({ kind: "upcoming", entryIndex: pl.order[i]! });
  return { rows, hiddenPlayed, hiddenUpcoming: Math.max(0, len - to) };
}

/** The end of the list was reached with Repeat off: remembered with the Playlist start and the cursor it happened at. */
export interface EndedMark {
  gen: number;
  cursor: number;
}
export const markEnded = (pl: Playlist, gen: number): EndedMark => ({ gen, cursor: pl.cursor });

/**
 * Whether the panel shows "Playlist ended" (spec 4.8 Repeat): only on the last Entry with Repeat off, and it clears by
 * itself when anything moves the cursor, turns Repeat on, or a new Playlist starts.
 */
export function endedShows(mark: EndedMark | null, pl: Playlist, gen: number): boolean {
  return !!mark && mark.gen === gen && mark.cursor === pl.cursor && pl.repeat === "off" && pl.cursor === pl.order.length - 1;
}

/** "show played" is remembered with the Playlist start (`gen`) it was set under: a new Playlist reads it as off. */
export interface ShowPlayed {
  gen: number;
  on: boolean;
}
export const showPlayedFor = (s: ShowPlayed, gen: number): boolean => s.on && s.gen === gen;
export const toggleShowPlayed = (s: ShowPlayed, gen: number): ShowPlayed => ({ gen, on: !showPlayedFor(s, gen) });
