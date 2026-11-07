import { openDb } from "/home/user/TuvaVideos/src/server/db";
const p = process.argv[2]!;
try { openDb(p, "/home/user/TuvaVideos/migrations"); console.log("OK", process.pid); } catch (e) { console.log("FAIL", process.pid, String(e).slice(0, 300)); }
