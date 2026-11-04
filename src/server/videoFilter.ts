// The "which Videos" clause the matcher passes share: one Video (`videoId`), a batch (`videoIds`, the Videos a scan
// added: audit DB-4), or every Video.
export interface VideoScope {
  videoId?: string;
  videoIds?: string[];
}

export function videoFilter(col: string, opts: VideoScope): { sql: string; params: string[] } {
  if (opts.videoIds) return { sql: `AND ${col} IN (SELECT value FROM json_each(?))`, params: [JSON.stringify(opts.videoIds)] };
  if (opts.videoId != null) return { sql: `AND ${col} = ?`, params: [opts.videoId] };
  return { sql: "", params: [] };
}

/** True when the pass is limited to some Videos (it then skips its Chapter and Artist parts). */
export const scoped = (opts: VideoScope) => opts.videoId != null || opts.videoIds != null;
