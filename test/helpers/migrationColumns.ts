// The column list of every `create table public.<name> (...)` in an archive migration, for the check that the Local
// copy's Shared tables match archive migration 130 (ticket #126). Run once to (re)generate the checked-in fixture:
//
//   git -C "<Lyrics Website checkout>" show origin/main:supabase/migrations/130_video_library.sql > /tmp/130.sql
//   bun test/helpers/migrationColumns.ts /tmp/130.sql > test/fixtures/migration-130-columns.json
//
// A small line parser, not a SQL parser: it reads the one-column-per-line layout the archive's migrations use.
import { readFileSync } from "node:fs";

export interface MigrationColumn {
  name: string;
  /** The Postgres type as written (`uuid`, `text`, `timestamptz`, `double precision`, ...). */
  type: string;
  notNull: boolean;
}

const NOT_COLUMN = /^(constraint|unique|check|primary\s+key|foreign\s+key|exclude|references|on)\b/i;
const TYPE_END = /\s+(primary|references|not|null|default|unique|check|generated|collate|constraint)\b/i;

export function extractCreateTableColumns(sql: string): Record<string, MigrationColumn[]> {
  const out: Record<string, MigrationColumn[]> = {};
  const re = /create table (?:public\.)?(\w+) \(\n([\s\S]*?)\n\);/gi;
  for (const m of sql.matchAll(re)) {
    const cols: MigrationColumn[] = [];
    let depth = 0;
    for (const raw of m[2]!.split("\n")) {
      const line = raw.replace(/--.*$/, "").trim();
      const atTop = depth === 0;
      for (const ch of line) depth += ch === "(" ? 1 : ch === ")" ? -1 : 0;
      if (!atTop || !line || NOT_COLUMN.test(line)) continue;
      const cm = /^(\w+)\s+(.+?),?$/.exec(line);
      if (!cm) continue;
      const rest = cm[2]!;
      const end = TYPE_END.exec(rest);
      const type = (end ? rest.slice(0, end.index) : rest).trim().replace(/,$/, "").toLowerCase();
      cols.push({ name: cm[1]!, type, notNull: /\bnot null\b/i.test(rest) || /\bprimary key\b/i.test(rest) });
    }
    out[m[1]!] = cols;
  }
  return out;
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: bun test/helpers/migrationColumns.ts <130_video_library.sql>");
    process.exit(2);
  }
  console.log(JSON.stringify(extractCreateTableColumns(readFileSync(file, "utf8")), null, 2));
}
