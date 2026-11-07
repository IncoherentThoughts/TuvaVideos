const r = await fetch(process.argv[2]);
const rd = r.body!.getReader(); let n = 0;
const first = await rd.read(); n += first.value!.length;
console.log("status", r.status, "len", r.headers.get("content-length"), "first", n);
await Bun.sleep(Number(process.argv[3]) * 1000);
try { for (;;) { const { done, value } = await rd.read(); if (done) break; n += value.length; } console.log("total", n); } catch (e) { console.log("error after pause", String(e), "got", n); }
