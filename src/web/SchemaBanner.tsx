// §6.4 the schema gate's banner (#158, M30/M31): above the grid while the last Sync that reached whoami found this
// checkout's Shared schema and the archive's apart. Behind: "Update TuvaVideos: git pull, then restart"; ahead: the
// line naming the mismatch (both from schemaGateLine in src/shared/session.ts). Not dismissable; browsing and
// playback carry on; it clears when a later Sync succeeds (the reducer's sync-end).
import { useSession } from "./session";

export function SchemaBanner() {
  const m = useSession().schemaMismatch;
  if (!m) return null;
  return (
    <div class={`root-bar schema-bar${m.behind ? " behind" : ""}`} role="status">
      <span>{m.line}</span>
    </div>
  );
}
