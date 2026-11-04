import { sanitizeLine, sanitizeFootnoteHtml } from "/home/user/TuvaVideos/src/shared/lyrics/sanitize";
import { augmentMarkers, defaultMarkerLabel } from "/home/user/TuvaVideos/src/shared/lyrics/markers";
import { parseHtmlToLines } from "/home/user/TuvaVideos/src/shared/lyrics/normalize";
(window as any).S = { sanitizeLine, sanitizeFootnoteHtml, augment: (html: string, fns: any[]) => augmentMarkers(parseHtmlToLines(html), fns, { kind: "fn", idPrefix: "p", label: defaultMarkerLabel }).map((l) => l.innerHTML).join("") };
