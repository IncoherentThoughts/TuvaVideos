// Grid arithmetic (docs/tv-spec.md 5.3): six columns, windowed by rows, paged with ChannelUp/Down. Pure.

export const COLS = 6
/** Height of one row of cards including the gap under it; the CSS gives `.card` the same height minus the gap. */
export const ROW_H = 312
/** Rows rendered above and below what is on screen, so Up and Down always find a neighbour. */
export const ROW_BUFFER = 3

export const rowOf = (index: number, cols = COLS) => Math.floor(index / cols)
export const colOf = (index: number, cols = COLS) => index % cols

/** The rows to render: the visible ones plus the buffer, clamped to the grid. `last` is exclusive. */
export function windowRows(scrollTop: number, viewH: number, totalRows: number, rowH = ROW_H, buffer = ROW_BUFFER): { first: number; last: number } {
  const first = Math.max(0, Math.floor(scrollTop / rowH) - buffer)
  const last = Math.min(totalRows, Math.ceil((scrollTop + viewH) / rowH) + buffer)
  return { first, last: Math.max(first, last) }
}

/** The tile indices to render for a window of rows. */
export function windowRange(count: number, rows: { first: number; last: number }, cols = COLS): { from: number; to: number } {
  return { from: Math.min(count, rows.first * cols), to: Math.min(count, rows.last * cols) }
}

/** ChannelDown / ChannelUp: the same column, a page of rows away; the last row of a short column lands on the last tile. */
export function pageTarget(index: number, count: number, rowsPerPage: number, dir: 1 | -1, cols = COLS): number {
  if (count <= 0) return 0
  const next = index + dir * rowsPerPage * cols
  if (next < 0) return colOf(index, cols) // the top row, same column
  if (next >= count) return Math.min(count - 1, index + (Math.floor((count - 1) / cols) - rowOf(index, cols)) * cols) // the last row
  return next
}

/** The scrollTop that puts `row` at the top of the view with a margin above it. */
export const scrollForRow = (row: number, margin = 24, rowH = ROW_H) => Math.max(0, row * rowH - margin)
