// Stage 2, pure parts: choosing the text block from YouTube info, merging Performance offsets into it, and the re-run
// rules (docs/chapter-pipeline.md "Sources and precedence", "Re-runs"). Nothing here touches the database.
import { parseTimestampBlock, type TimestampEntry } from "../../shared/timestamps";

export type ChapterSource = "description" | "comment" | "performance";

export interface YtComment {
  id?: string;
  text?: string;
  like_count?: number | null;
  author_is_uploader?: boolean;
  is_pinned?: boolean;
  parent?: string;
}

export interface YtInfo {
  id?: string;
  duration?: number | null;
  description?: string | null;
  comments?: YtComment[] | null;
}

export interface TextBlock {
  source: "description" | "comment";
  entries: TimestampEntry[];
  /** For a comment block: which comment, with the facts the choice was made on. */
  comment?: { id: string | null; likes: number; pinnedOrUploader: boolean };
}

/**
 * The description block when it parses (comments are then ignored); otherwise the best comment block: among comments whose
 * text parses to a block, pinned or uploader first, then most likes, then most entries (then the earlier comment).
 */
export function selectBlock(info: YtInfo, duration: number | null): TextBlock | null {
  const desc = parseTimestampBlock(info.description ?? "", duration);
  if (desc.length) return { source: "description", entries: desc };
  let best: CommentBlock | null = null;
  for (const c of info.comments ?? []) {
    const entries = parseTimestampBlock(c.text ?? "", duration);
    if (!entries.length) continue;
    const cand = {
      source: "comment" as const,
      entries,
      comment: { id: c.id ?? null, likes: Number(c.like_count ?? 0) || 0, pinnedOrUploader: !!(c.is_pinned || c.author_is_uploader) },
    };
    if (!best || beats(cand, best)) best = cand;
  }
  return best;
}

type CommentBlock = TextBlock & { comment: NonNullable<TextBlock["comment"]> };

function beats(a: CommentBlock, b: CommentBlock): boolean {
  if (a.comment.pinnedOrUploader !== b.comment.pinnedOrUploader) return a.comment.pinnedOrUploader;
  if (a.comment.likes !== b.comment.likes) return a.comment.likes > b.comment.likes;
  return a.entries.length > b.entries.length;
}

// ---- Candidates and the Performance merge ----

export interface Candidate {
  startS: number;
  title: string;
  /** Mirror Song uuid (from a Performance or the Song matcher), or null. */
  songId: string | null;
  source: ChapterSource;
  /** Where the Song came from, for the report. */
  songFrom: "performance" | "matcher" | null;
}

export interface PerformanceOffset {
  songId: string;
  startS: number;
  /** The Song's name, the title of a Chapter that no text entry covers. */
  songName: string;
}

export const MERGE_WINDOW_S = 15;
export const NEAR_EXISTING_S = 10;

/**
 * Text entries become Chapters of the block's source; every Performance offset becomes a Chapter with the Song attached
 * and the Song's name as title, unless a text entry lies within ±15 s: then the text supplies time and title and the
 * Performance supplies the Song. A text entry takes at most one Performance (the nearest first, in time order); a Song
 * listed twice at the same offset counts once.
 */
export function mergePerformances(text: TextBlock | null, perfs: readonly PerformanceOffset[]): Candidate[] {
  const entries = text?.entries ?? [];
  const out: Candidate[] = entries.map((e) => ({ startS: e.startS, title: e.title, songId: null, source: text!.source, songFrom: null }));
  const seen = new Set<string>();
  const unique = perfs.filter((p) => {
    const k = `${p.songId}@${p.startS}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  // closest pairs first so a Performance cannot steal the entry that a nearer one belongs to
  const pairs: { pi: number; ci: number; d: number }[] = [];
  unique.forEach((p, pi) => out.forEach((c, ci) => {
    if (c.source === "performance") return;
    const d = Math.abs(c.startS - p.startS);
    if (d <= MERGE_WINDOW_S) pairs.push({ pi, ci, d });
  }));
  pairs.sort((a, b) => a.d - b.d || a.pi - b.pi || a.ci - b.ci);
  const usedP = new Set<number>();
  const usedC = new Set<number>();
  for (const { pi, ci } of pairs) {
    if (usedP.has(pi) || usedC.has(ci)) continue;
    usedP.add(pi);
    usedC.add(ci);
    const c = out[ci]!;
    c.songId = unique[pi]!.songId;
    c.songFrom = "performance";
    if (!c.title.trim()) c.title = unique[pi]!.songName;
  }
  unique.forEach((p, pi) => {
    if (usedP.has(pi)) return;
    out.push({ startS: p.startS, title: p.songName, songId: p.songId, source: "performance", songFrom: "performance" });
  });
  return out.sort((a, b) => a.startS - b.startS);
}

// ---- Re-run rules ----

export interface RuleOutcome {
  keep: Candidate[];
  /** Within ±10 s of a confirmed or manual Chapter. */
  nearKept: Candidate[];
  /** Same source and within ±10 s of a rejection. */
  tombstoned: Candidate[];
  /** Same start as an earlier candidate (UNIQUE (video_id, start_s)). */
  collided: Candidate[];
}

/**
 * `kept` are the Video's confirmed and manual Chapter starts; `tombstones` its rejections. Candidates arrive in any order
 * and leave sorted by start.
 */
export function applyRerunRules(
  cands: readonly Candidate[],
  kept: readonly number[],
  tombstones: readonly { source: string; startS: number }[],
): RuleOutcome {
  const out: RuleOutcome = { keep: [], nearKept: [], tombstoned: [], collided: [] };
  const taken = new Set<number>();
  for (const c of [...cands].sort((a, b) => a.startS - b.startS)) {
    if (kept.some((k) => Math.abs(k - c.startS) <= NEAR_EXISTING_S)) out.nearKept.push(c);
    else if (tombstones.some((t) => t.source === c.source && Math.abs(t.startS - c.startS) <= NEAR_EXISTING_S)) out.tombstoned.push(c);
    else if (taken.has(c.startS)) out.collided.push(c);
    else {
      taken.add(c.startS);
      out.keep.push(c);
    }
  }
  return out;
}
