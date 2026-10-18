// The coloured action pills on history entries (ticket #159): the Video's History tab and the Edits view both label
// each write with what it did, one pill per distinct action. Pure; the pill is drawn by `ActionPills` in
// src/web/History.tsx and coloured by `.apill.<kind>` in styles.css (palette tokens only).

/** What a history row did. `undo` wins over everything else: a row that reverses another is an undo first. */
export type ActionKind =
  | "edit" | "create" | "delete" | "restore" | "undo" | "repoint" | "share" | "elevate" | "expose"
  | "suggest" | "confirm" | "reject" | "migrate";

export interface ActionPill {
  kind: ActionKind;
  /** The pill's text, lower case. */
  label: string;
}

/** Classifies one `video_edit_history` row by its event type (src/shared/archiveWire.ts `EVENT_TYPES`). */
export function actionPill(eventType: string, reverses: string | null = null): ActionPill {
  if (reverses) return { kind: "undo", label: "undo" };
  const [family = "", act = ""] = eventType.split(".", 2);
  if (eventType === "video.scanned") return { kind: "share", label: "share" };
  if (eventType === "video.restored") return { kind: "restore", label: "restore" };
  if (act === "unrejected") return { kind: "restore", label: "unreject" };
  if (family === "exposure") return { kind: "expose", label: act === "unexposed" ? "unexpose" : "expose" };
  if (act === "repointed") return { kind: "repoint", label: "repoint" };
  if (act === "migrated") return { kind: "migrate", label: "migrate" };
  if (act === "suggested") return { kind: "suggest", label: "suggest" };
  if (act === "confirmed") return { kind: "confirm", label: "confirm" };
  if (act === "rejected") return { kind: "reject", label: "reject" };
  if (act.endsWith("_elevated")) return { kind: "elevate", label: "elevate" };
  if (act === "added" || act.endsWith("_created")) return { kind: "create", label: "create" };
  // `video.deleted` is the soft delete (§4.6); a Chapter's or a Proposed row's delete is a plain one.
  if (eventType === "video.deleted") return { kind: "delete", label: "soft delete" };
  if (act === "deleted" || act.endsWith("_deleted")) return { kind: "delete", label: "delete" };
  return { kind: "edit", label: "edit" };
}

/** One write's pills: each distinct action once, in the order its rows first show it. */
export function writePills(entries: readonly { eventType: string; reverses: string | null }[]): ActionPill[] {
  const out: ActionPill[] = [];
  for (const e of entries) {
    const p = actionPill(e.eventType, e.reverses);
    if (!out.some((x) => x.kind === p.kind && x.label === p.label)) out.push(p);
  }
  return out;
}
