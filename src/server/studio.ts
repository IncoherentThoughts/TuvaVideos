// The Studio matcher (spec 7.3) runs after every Mirror import. The matcher itself arrives with ticket #27; this is
// the seam the import calls, a no-op until then.
import type { Db } from "./db";
import { log } from "./log";

export async function runStudioMatcher(_db: Db): Promise<void> {
  log("studio matcher: not built yet (ticket #27), skipped");
}
