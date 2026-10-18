// Row ids of the Local copy (docs/sharing-spec.md §3, §6.1). Every Shared row has a uuid the client may mint; the rows
// that had integer ids before migration 0015 got a deterministic uuid, so the one-time migration script (§9.2, ticket
// #113) can recompute the same map from the old ids without a lookup table. Pure.

export type LegacyKind = "video" | "chapter" | "artist";

/** First group of the legacy uuid per kind: "vid", "chp", "art" in ASCII, zero-padded. */
const PREFIX: Record<LegacyKind, string> = { video: "76696400", chapter: "63687000", artist: "61727400" };
const KIND_OF = new Map(Object.entries(PREFIX).map(([k, p]) => [p, k as LegacyKind]));

/**
 * The uuid migration 0015 gave the integer row `n` of `kind` (Videos, Chapters, Local Artists): an RFC 9562 version-8
 * (custom) uuid `<prefix>-0000-8000-8000-<n as 12 hex digits>`. The SQL in the migration is
 * `printf('<prefix>-0000-8000-8000-%012x', id)`; test/localCopy.test.ts checks that the two agree.
 */
export function legacyUuid(kind: LegacyKind, n: number): string {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffffffff) throw new RangeError(`not a legacy row id: ${n}`);
  return `${PREFIX[kind]}-0000-8000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** The inverse of `legacyUuid`, or null for any other uuid (a Shared row minted by a client or the server). */
export function legacyIdOf(uuid: string): { kind: LegacyKind; id: number } | null {
  const m = /^([0-9a-f]{8})-0000-8000-8000-([0-9a-f]{12})$/.exec(uuid.toLowerCase());
  const kind = m ? KIND_OF.get(m[1]!) : undefined;
  return kind ? { kind, id: parseInt(m![2]!, 16) } : null;
}

/** A new row id (version 4). */
export const newUuid = (): string => crypto.randomUUID();

export { isUuid, UUID_PATTERN } from "../../shared/ids";
