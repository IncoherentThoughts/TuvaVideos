// Parses the TUVA / TUVAPP / TUVAFILE stdout lines (downloader-spec §4.3) and keeps the two-stream byte count. Pure.

export type DownloadLine = {
  kind: "download";
  status: string;
  downloaded: number | null;
  total: number | null;
  totalEstimate: number | null;
  speed: number | null;
  eta: number | null;
};
export type ProgressLine = DownloadLine | { kind: "postprocess"; status: string } | { kind: "file"; path: string };

const nul = (s: string | undefined): number | null => {
  if (s === undefined || s === "NA" || s === "None" || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** null for every line that is not ours (yt-dlp's own `[download] ...` chatter). */
export function parseLine(line: string): ProgressLine | null {
  if (line.startsWith("TUVAFILE ")) {
    const path = line.slice(9).trim();
    return path ? { kind: "file", path } : null;
  }
  if (line.startsWith("TUVAPP ")) return { kind: "postprocess", status: line.slice(7).trim() };
  if (line.startsWith("TUVA ")) {
    const f = line.slice(5).trim().split(/\s+/);
    if (f.length < 6) return null;
    return { kind: "download", status: f[0]!, downloaded: nul(f[1]), total: nul(f[2]), totalEstimate: nul(f[3]), speed: nul(f[4]), eta: nul(f[5]) };
  }
  return null;
}

export interface Bytes {
  doneBytes: number;
  /** `exactBytes` when sized, else finished streams + the current stream's total (or estimate); null when unknown. */
  totalBytes: number | null;
}

/**
 * `bv+ba` downloads two files that report separately. Done bytes are the finished streams plus the current stream's
 * `downloaded_bytes` (which already counts bytes on disk after a resume), against the sizing pass's exact bytes.
 */
export class ByteCounter {
  private finished = 0;
  private current = 0;
  private currentTotal: number | null = null;

  constructor(private readonly exactBytes: number | null = null) {}

  feed(p: DownloadLine): Bytes {
    const total = p.total ?? p.totalEstimate;
    if (p.status === "finished") {
      this.finished += p.downloaded ?? p.total ?? this.current;
      this.current = 0;
      this.currentTotal = null;
    } else {
      this.current = p.downloaded ?? this.current;
      this.currentTotal = total ?? this.currentTotal;
    }
    return this.snapshot();
  }

  snapshot(): Bytes {
    const done = this.finished + this.current;
    const total = this.exactBytes ?? (this.currentTotal !== null ? this.finished + this.currentTotal : null);
    return { doneBytes: done, totalBytes: total === null ? null : Math.max(total, done) };
  }
}
