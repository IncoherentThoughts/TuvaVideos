// Ported from the archive, src/lib/lyrics/trackVersion.ts (ADR-0009 there). A Chapter that points at a Song and a
// Version has the same semantics as a Track Version: a null Version means the first in display order.

/** The label a new Song's first Version is born with. Not reserved: the default Version is the first in order. */
export const DEFAULT_VERSION_LABEL = "Complete";

/**
 * Which of `versions` (already in display order) the drawer opens on: the pointed-at Version when the Song still has
 * it, else the first, including when the pointer is null, dangling, or the list is empty.
 */
export function openingVersionIndex(versions: ReadonlyArray<{ id: string }>, versionId: string | null | undefined): number {
  if (!versionId) return 0;
  const i = versions.findIndex((v) => v.id === versionId);
  return i === -1 ? 0 : i;
}

/** Whether `index` is the pointed-at Version rather than the default: the "· this chapter" cue. */
export function isPointedVersionAt(versions: ReadonlyArray<{ id: string }>, versionId: string | null | undefined, index: number): boolean {
  return !!versionId && versions[index]?.id === versionId;
}
