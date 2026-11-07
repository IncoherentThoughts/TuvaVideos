// src/shared/lyrics/sanitize.ts
var PROFILE_CONFIG = {
  LINE: { ALLOWED_TAGS: ["p", "br", "b", "strong", "i", "em", "u", "s", "sub", "sup", "span"], ALLOWED_ATTR: ["class", "id", "role", "tabindex"], DATA_ARIA: true },
  FOOTNOTE: { ALLOWED_TAGS: ["b", "strong", "i", "em", "u", "br", "sub", "sup"], ALLOWED_ATTR: [], DATA_ARIA: false }
};
var VOID = new Set(["br"]);
var DROP_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "textarea", "title", "svg", "math"]);
var DATA_ARIA_NAME = /^(?:data|aria)-[\w.:-]+$/i;
var escAttr = (v) => v.replace(/&(?!(?:#\d+|#x[\da-f]+|\w+);)/gi, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function parseTag(html, at) {
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(at, at + 64));
  if (!m)
    return null;
  let i = at + m[0].length;
  const attrs = [];
  const n = html.length;
  for (;; ) {
    while (i < n && /[\s/]/.test(html[i]))
      i++;
    if (i >= n)
      return { name: m[2].toLowerCase(), closing: !!m[1], attrs, end: n };
    if (html[i] === ">")
      break;
    const nm = /^[^\s=>/]+/.exec(html.slice(i, i + 200));
    if (!nm) {
      i++;
      continue;
    }
    i += nm[0].length;
    while (i < n && /\s/.test(html[i]))
      i++;
    let val = "";
    if (html[i] === "=") {
      i++;
      while (i < n && /\s/.test(html[i]))
        i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        const e = close < 0 ? n : close;
        val = html.slice(i + 1, e);
        i = close < 0 ? n : e + 1;
      } else {
        const u = /^[^\s>]*/.exec(html.slice(i))[0];
        val = u;
        i += u.length;
      }
    }
    attrs.push([nm[0].toLowerCase(), val]);
  }
  return { name: m[2].toLowerCase(), closing: !!m[1], attrs, end: i + 1 };
}
function sanitize(html, profile) {
  if (!html)
    return "";
  const cfg = PROFILE_CONFIG[profile];
  const allowedTags = new Set(cfg.ALLOWED_TAGS);
  const allowedAttr = new Set(cfg.ALLOWED_ATTR);
  const stack = [];
  let out = "";
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt < 0) {
      out += html.slice(i);
      break;
    }
    out += html.slice(i, lt);
    if (html.startsWith("<!--", lt)) {
      const e = html.indexOf("-->", lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (html[lt + 1] === "!" || html[lt + 1] === "?") {
      const e = html.indexOf(">", lt);
      i = e < 0 ? n : e + 1;
      continue;
    }
    const tag = parseTag(html, lt);
    if (!tag) {
      out += "&lt;";
      i = lt + 1;
      continue;
    }
    i = tag.end;
    if (!tag.closing && DROP_CONTENT.has(tag.name)) {
      const m = new RegExp(`</${tag.name}\\s*>`, "i").exec(html.slice(i));
      i = m ? i + m.index + m[0].length : n;
      continue;
    }
    if (!allowedTags.has(tag.name))
      continue;
    if (tag.closing) {
      if (VOID.has(tag.name))
        continue;
      const at = stack.lastIndexOf(tag.name);
      if (at < 0)
        continue;
      while (stack.length > at)
        out += `</${stack.pop()}>`;
      continue;
    }
    let attrs = "";
    const seen = new Set;
    for (const [name, val] of tag.attrs) {
      if (seen.has(name))
        continue;
      if (!(allowedAttr.has(name) || cfg.DATA_ARIA && DATA_ARIA_NAME.test(name)))
        continue;
      seen.add(name);
      attrs += ` ${name}="${escAttr(val)}"`;
    }
    out += `<${tag.name}${attrs}>`;
    if (!VOID.has(tag.name))
      stack.push(tag.name);
  }
  while (stack.length)
    out += `</${stack.pop()}>`;
  return out;
}
var sanitizeLine = (html) => sanitize(html, "LINE");
var sanitizeFootnoteHtml = (html) => sanitize(html, "FOOTNOTE");

// src/shared/lyrics/normalize.ts
function stripHtml(s) {
  return (s || "").replace(/<[^>]*>/g, "");
}
function parseHtmlToLines(html) {
  if (!html)
    return [];
  const results = [];
  const re = /<p(?:[^>]*)>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const inner = m[1];
    const isBlank = inner === "<br>" || inner === "<br/>" || inner === "<br />" || inner === "" || inner === " " || inner === "&nbsp;" || inner.trim() === "<br>";
    results.push({ innerHTML: isBlank ? "" : inner, isBlank });
  }
  if (results.length === 0 && html.trim())
    results.push({ innerHTML: html, isBlank: false });
  return results;
}

// src/shared/lyrics/markers.ts
function markerDomId(kind, idPrefix, id, occurrence) {
  return `${kind}-marker-${idPrefix}-${id}-${occurrence}`;
}
function footnoteDefDomId(kind, idPrefix, id) {
  return `${kind}-def-${idPrefix}-${id}`;
}
function entriesById(footnotes) {
  const m = new Map;
  footnotes.forEach((f) => {
    if (!m.has(f.id))
      m.set(f.id, f);
  });
  return m;
}
function markerCaseFor(entry) {
  if (!entry)
    return "orphan";
  return stripHtml(entry.text).trim() ? "with-text" : "no-text";
}
var defaultMarkerLabel = ({ id, case: kase, text }) => kase === "orphan" ? `Footnote ${id} (missing)` : kase === "with-text" ? `Footnote ${id}: ${text}` : `Footnote ${id}`;
function augmentMarkers(lines, footnotes, { kind, idPrefix, label }) {
  const byId = entriesById(footnotes);
  const occ = new Map;
  return lines.map((line) => {
    if (line.isBlank)
      return { ...line };
    const inner = line.innerHTML.replace(/<sup\b([^>]*)\bdata-fn="(\d+)"([^>]*)>([^<]*)<\/sup>/gi, (_full, pre, num, post, body) => {
      const id = parseInt(num, 10);
      const count = (occ.get(id) ?? 0) + 1;
      occ.set(id, count);
      const entry = byId.get(id);
      const kase = markerCaseFor(entry);
      const text = kase === "with-text" ? stripHtml(entry.text).slice(0, 60) : "";
      const name = label({ id, case: kase, text });
      const orphanAttr = kase === "orphan" ? ' data-orphan="true"' : "";
      const describedBy = kase === "orphan" ? "" : ` aria-describedby="${footnoteDefDomId(kind, idPrefix, id)}"`;
      return `<sup${pre}data-fn="${id}"${post} id="${markerDomId(kind, idPrefix, id, count)}" role="doc-noteref" tabindex="0"${describedBy} aria-label="${name.replace(/"/g, "&quot;")}"${orphanAttr}>${body}</sup>`;
    });
    const withAdjacency = inner.replace(/(<\/sup>)(<sup\b)([^>]*)(>)/gi, (full, close, supOpen, attrs, gt) => /\bdata-fn=/.test(attrs) ? `${close}${supOpen}${attrs} data-adjacent="true"${gt}` : full);
    return { ...line, innerHTML: sanitizeLine(withAdjacency) };
  });
}

// ../../../tmp/claude-0/-home-user-TuvaVideos/81dd5c87-daef-5003-ad39-65f9bcc41023/scratchpad/audit-05/sanentry.ts
window.S = { sanitizeLine, sanitizeFootnoteHtml, augment: (html, fns) => augmentMarkers(parseHtmlToLines(html), fns, { kind: "fn", idPrefix: "p", label: defaultMarkerLabel }).map((l) => l.innerHTML).join("") };
