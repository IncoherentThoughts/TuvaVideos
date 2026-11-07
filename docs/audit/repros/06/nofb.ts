import { Database } from "bun:sqlite";
const db = new Database("/tmp/claude-0/-home-user-TuvaVideos/81dd5c87-daef-5003-ad39-65f9bcc41023/scratchpad/audit-06/data/library.db");
db.run("UPDATE copy SET fallback_file = NULL WHERE id = 46");
console.log(db.query("SELECT id, playback, fallback_file FROM copy WHERE id=46").get());
