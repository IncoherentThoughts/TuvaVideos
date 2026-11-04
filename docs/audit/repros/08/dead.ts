import { Glob } from "bun";
const root = "/home/user/TuvaVideos/";
const files: string[] = [];
for (const pat of ["src/**/*.{ts,tsx}", "test/**/*.ts", "scripts/**/*.ts"]) for (const f of new Glob(pat).scanSync(root)) files.push(f);
const text = new Map(files.map((f) => [f, Bun.file(root + f).text()]));
const src = new Map<string, string>();
for (const [f, p] of text) src.set(f, await p);
const exp = /export\s+(?:async\s+)?(?:function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
for (const [f, s] of src) {
  if (!f.startsWith("src/")) continue;
  for (const m of s.matchAll(exp)) {
    const name = m[1]!;
    const re = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`, "g");
    let inFile = (s.match(re) ?? []).length - 1;
    let other = 0, testOnly = 0;
    for (const [g, t] of src) { if (g === f) continue; const n = (t.match(re) ?? []).length; if (n) { if (g.startsWith("test/")) testOnly += n; else other += n; } }
    if (other === 0) console.log(`${testOnly ? "TEST-ONLY" : (inFile > 0 ? "LOCAL-ONLY" : "UNUSED")}\t${f}\t${name}\tinFile=${inFile} test=${testOnly}`);
  }
}
