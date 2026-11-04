import { readdirSync } from "node:fs";
import { Database } from "bun:sqlite";
const n = "Кӧмей [aaaaaaaaaaa].mp4";
console.log(n.length, n.normalize("NFC").length, n.normalize("NFD").length, n === n.normalize("NFC"));
const d = new Database(":memory:"); d.exec("create table c(id integer primary key, p text unique)");
d.query("insert into c(p) values (?)").run(n.normalize("NFC")); d.query("insert into c(p) values (?)").run(n.normalize("NFD"));
try { d.query("update c set p=? where id=2").run(n.normalize("NFC")); console.log("no throw", d.query("select id, length(p) l from c").all()); } catch (e) { console.log("threw", String(e)); }
