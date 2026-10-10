// HTTP Range header parsing (single range). Pure.

export type RangeResult =
  | { kind: "none" }
  | { kind: "range"; start: number; end: number } // inclusive
  | { kind: "unsatisfiable" };

/**
 * `bytes=a-b`, `bytes=a-`, `bytes=-n`. Anything malformed, in another unit or with several ranges
 * is ignored (the whole file is sent with 200), which RFC 9110 allows.
 */
export function parseRange(header: string | null | undefined, size: number): RangeResult {
  if (!header) return { kind: "none" };
  const m = header.trim().match(/^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/i);
  if (!m) return { kind: "none" };
  const [, a, b] = m as unknown as [string, string, string];
  if (a === "" && b === "") return { kind: "none" };
  if (a === "") {
    const n = Number(b);
    if (n === 0) return { kind: "unsatisfiable" };
    if (size === 0) return { kind: "unsatisfiable" };
    return { kind: "range", start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(a);
  if (start >= size) return { kind: "unsatisfiable" };
  const end = b === "" ? size - 1 : Math.min(Number(b), size - 1);
  if (end < start) return { kind: "none" };
  return { kind: "range", start, end };
}
