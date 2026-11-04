import { Database } from "bun:sqlite";
const db = new Database(process.argv[2]!);
const payloads = [
  `<p>a<img src=x onerror="window.__xss='img'">b</p>`,
  `<p><sup data-fn="1" onmouseover="window.__xss='sup'">1</sup> marker</p>`,
  `<p><b<img src=x onerror=window.__xss='nest'>>x</b></p>`,
  `<p><span title="</span><img src=x onerror=window.__xss='attr'>">t</span></p>`,
  `<p><svg><animate onbegin=window.__xss='svg'></svg>z</p>`,
  `<p><a href="javascript:window.__xss='a'">click</a></p>`,
  `<p><sup data-fn="2" x=">" onfocus="window.__xss='q'" >2</sup></p>`,
  `<p><noscript><p title="</noscript><img src=x onerror=window.__xss='ns'>"></noscript></p>`,
  `<p><math><mtext><table><mglyph><style><img src=x onerror=window.__xss='mx'></style></math></p>`,
  `<p><span class="x" style="position:fixed;inset:0;background:red">style</span></p>`,
  `<p><span id="lyrbody">clobber</span></p>`,
  `<p><scr<script>ipt>window.__xss='split'</script></p>`,
  `<p><sup data-fn="1">1</sup><sup data-fn="3">3</sup></p>`,
].join("");
const fn = JSON.stringify([{ id: 1, text: `<img src=x onerror="window.__xss='fn'">foot <b>bold</b>` }, { id: 2, text: `<a href=javascript:alert(1)>x</a>` }]);
db.query("UPDATE local_version SET cyrillic = ?, footnotes_cyrillic = ?").run(payloads, fn);
console.log(db.query("SELECT id, label FROM local_version").all());
