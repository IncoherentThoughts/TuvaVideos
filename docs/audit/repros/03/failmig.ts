import { openDb } from "/home/user/TuvaVideos/src/server/db";
import { Database } from "bun:sqlite";
const p = process.argv[2]!;
try { openDb(p, process.argv[3]!); console.log("opened"); } catch (e) { console.log("FAIL:", String(e).slice(0, 160)); }
const d = new Database(p);
console.log(d.query("select name from sqlite_master where name like 'zz_%'").all(), d.query("pragma user_version").get(), d.query("select max(name) m from migration").get(), d.query("pragma foreign_keys").get());
