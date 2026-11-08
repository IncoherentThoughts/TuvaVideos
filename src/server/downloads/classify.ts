// Failure classes (downloader-spec §4.4). Pure. First matching row wins; the order below is deliberate.

export type FailureReason =
  | "unavailable"
  | "private"
  | "geo"
  | "login_wall"
  | "private_follow"
  | "cookies_expired"
  | "needs_signin"
  | "youtube_signin"
  | "rate_limited"
  | "disk_full"
  | "network"
  | "no_js_runtime"
  | "unknown";

const COOKIES_EXPIRED = /account cookies are no longer valid/i;

// Instagram's messages carry yt-dlp's "--cookies" hint, and so does YouTube's bot check ("Please sign in. Use --cookies..."),
// and a 429 during download reads "unable to download video data", so the specific rows come before the generic ones.
const ROWS: Array<[FailureReason, RegExp]> = [
  ["private_follow", /only available for registered users who follow/i],
  ["login_wall", /redirected to the login page|Restricted Video|empty media response/i],
  ["disk_full", /No space left on device|Errno 28/i],
  ["youtube_signin", /Sign in to confirm|Please sign in/i],
  ["rate_limited", /HTTP Error 429|rate-?limit|Too Many Requests/i],
  ["no_js_runtime", /JavaScript runtime|n challenge|Signature extraction failed/i],
  ["private", /Private video/i],
  ["geo", /geo.?restrict|not available from your location|in your country/i],
  ["unavailable", /Video unavailable|This video is unavailable|has been removed|There is no video in this post/i],
  ["network", /Unable to download|timed out|Connection|Temporary failure in name resolution|Got error|HTTP Error 5\d\d/i],
];

/** The last `ERROR:` line without the prefix; null if there is none. */
export function lastErrorLine(lines: readonly string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i]!.match(/^\s*ERROR:\s*(.*)$/);
    if (m) return m[1]!.trim();
  }
  return null;
}

/** `lines` is everything the run printed (stdout and stderr): the cookies warning can be on any line. */
export function classify(lines: readonly string[]): { reason: FailureReason; errorLine: string | null } {
  const errorLine = lastErrorLine(lines);
  if (lines.some((l) => COOKIES_EXPIRED.test(l))) return { reason: "cookies_expired", errorLine };
  if (errorLine === null) return { reason: "unknown", errorLine };
  for (const [reason, re] of ROWS) if (re.test(errorLine)) return { reason, errorLine };
  return { reason: "unknown", errorLine };
}
