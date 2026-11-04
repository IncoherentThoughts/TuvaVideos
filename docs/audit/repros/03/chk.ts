import { Database } from "bun:sqlite";
for (const f of process.argv.slice(2)) { const d = new Database(f); console.log(f, d.query("select count(*) n from migration").get(), d.query("pragma user_version").get(), d.query("pragma integrity_check").get(), d.query("select count(*) n from sqlite_master where name in ('videos','copy','video')").get()); }
