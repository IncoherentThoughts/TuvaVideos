// The Failure report text (downloader-spec §9) and the reason words. Pure.

import type { FailureReason } from "./classify";

export const REASON_WORDS: Record<FailureReason, string> = {
  unavailable: "unavailable",
  private: "private",
  geo: "not available in your country",
  login_wall: "login wall or removed post",
  private_follow: "private: follow required",
  cookies_expired: "cookies expired",
  needs_signin: "needs sign-in",
  youtube_signin: "rate limited",
  rate_limited: "rate limited",
  disk_full: "disk full",
  network: "network",
  no_js_runtime: "no JavaScript runtime",
  unknown: "unknown error",
};

export const reasonWords = (reason: string | null): string => REASON_WORDS[(reason ?? "unknown") as FailureReason] ?? "unknown error";

export interface ReportJob {
  createdAt: string;
  quality: string;
  destDir: string;
}
export interface ReportItem {
  title: string;
  sourceUrl: string;
  reason: string | null;
  errorLine: string | null;
}

const p2 = (n: number) => String(n).padStart(2, "0");
/** `YYYY-MM-DD` in this machine's local time. */
export const localDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
export const localDateTime = (iso: string) => {
  const d = new Date(iso);
  return `${localDate(iso)} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

export const qualityWords = (q: string) => (q === "best" ? "best quality" : `${q}p`);

export const reportFileName = (job: ReportJob) => `TuvaVideos failed downloads ${localDate(job.createdAt)}.txt`;

/** `total` is every Video in the job, `failed` the ones that failed (the report lists exactly these). */
export function failureReport(job: ReportJob, total: number, failed: ReportItem[]): string {
  const head = [
    "TuvaVideos — failed downloads",
    `Job of ${localDateTime(job.createdAt)} · ${qualityWords(job.quality)} · into ${job.destDir}`,
    `${failed.length} of ${total} Videos failed`,
    "",
  ];
  const body = failed.map((f) => [f.title, `  ${f.sourceUrl}`, `  ${reasonWords(f.reason)}${f.errorLine ? ` — ${f.errorLine}` : ""}`, ""].join("\n"));
  return head.join("\n") + "\n" + body.join("\n");
}
