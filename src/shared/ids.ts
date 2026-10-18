// Row ids as the server and the clients see them: uuids (docs/sharing-spec.md §3, migration 0015). Copies, Roots and
// Studio tracks stay local integers. Pure.

/** A uuid as it appears in a route (`/play/<uuid>`, `/api/videos/<uuid>`). */
export const UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const UUID_RE = new RegExp(`^${UUID_PATTERN}$`);

export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID_RE.test(s);
