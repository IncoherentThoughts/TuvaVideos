// The archive's sanitizer profiles (src/lib/sanitize.ts: LINE and FOOTNOTE, tag and attribute lists byte for byte)
// applied by a small dependency-free tokenizer instead of DOMPurify, so the same code runs in the server (no DOM there)
// and in the browser. Disallowed tags are unwrapped (their text is kept, as DOMPurify's KEEP_CONTENT does) except
// script, style and friends, whose content goes too. Comments and doctypes are dropped. Allowed tags are re-balanced.
// DOMPurify also lets `data-*` and `aria-*` attributes through by default; LINE keeps that, FOOTNOTE allows none.

export type Profile = "LINE" | "FOOTNOTE";

export const PROFILE_CONFIG: Readonly<Record<Profile, { ALLOWED_TAGS: readonly string[]; ALLOWED_ATTR: readonly string[]; DATA_ARIA: boolean }>> = {
  LINE: { ALLOWED_TAGS: ["p", "br", "b", "strong", "i", "em", "u", "s", "sub", "sup", "span"], ALLOWED_ATTR: ["class", "id", "role", "tabindex"], DATA_ARIA: true },
  FOOTNOTE: { ALLOWED_TAGS: ["b", "strong", "i", "em", "u", "br", "sub", "sup"], ALLOWED_ATTR: [], DATA_ARIA: false },
};

const VOID = new Set(["br"]);
const DROP_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "noscript", "template", "textarea", "title", "svg", "math"]);
const DATA_ARIA_NAME = /^(?:data|aria)-[\w.:-]+$/i;

const escAttr = (v: string) => v.replace(/&(?!(?:#\d+|#x[\da-f]+|\w+);)/gi, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Tag {
  name: string;
  closing: boolean;
  attrs: [string, string][];
  end: number;
}

/** Parses a tag starting at `html[at] === "<"`; null when it is not a tag (a bare `<`). Honours quoted `>` in attributes. */
function parseTag(html: string, at: number): Tag | null {
  const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)/.exec(html.slice(at, at + 64));
  if (!m) return null;
  let i = at + m[0].length;
  const attrs: [string, string][] = [];
  const n = html.length;
  for (;;) {
    while (i < n && /[\s/]/.test(html[i]!)) i++;
    if (i >= n) return { name: m[2]!.toLowerCase(), closing: !!m[1], attrs, end: n };
    if (html[i] === ">") break;
    const nm = /^[^\s=>/]+/.exec(html.slice(i, i + 200));
    if (!nm) {
      i++;
      continue;
    }
    i += nm[0].length;
    while (i < n && /\s/.test(html[i]!)) i++;
    let val = "";
    if (html[i] === "=") {
      i++;
      while (i < n && /\s/.test(html[i]!)) i++;
      const q = html[i];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, i + 1);
        const e = close < 0 ? n : close;
        val = html.slice(i + 1, e);
        i = close < 0 ? n : e + 1;
      } else {
        const u = /^[^\s>]*/.exec(html.slice(i))![0];
        val = u;
        i += u.length;
      }
    }
    attrs.push([nm[0].toLowerCase(), val]);
  }
  return { name: m[2]!.toLowerCase(), closing: !!m[1], attrs, end: i + 1 };
}

export function sanitize(html: string, profile: Profile): string {
  if (!html) return "";
  const cfg = PROFILE_CONFIG[profile];
  const allowedTags = new Set(cfg.ALLOWED_TAGS);
  const allowedAttr = new Set(cfg.ALLOWED_ATTR);
  const stack: string[] = [];
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
    if (!allowedTags.has(tag.name)) continue; // unwrapped: the text around it stays
    if (tag.closing) {
      if (VOID.has(tag.name)) continue;
      const at = stack.lastIndexOf(tag.name);
      if (at < 0) continue; // stray closing tag
      while (stack.length > at) out += `</${stack.pop()}>`;
      continue;
    }
    let attrs = "";
    const seen = new Set<string>();
    for (const [name, val] of tag.attrs) {
      if (seen.has(name)) continue;
      if (!(allowedAttr.has(name) || (cfg.DATA_ARIA && DATA_ARIA_NAME.test(name)))) continue;
      seen.add(name);
      attrs += ` ${name}="${escAttr(val)}"`;
    }
    out += `<${tag.name}${attrs}>`;
    if (!VOID.has(tag.name)) stack.push(tag.name);
  }
  while (stack.length) out += `</${stack.pop()}>`;
  return out;
}

export const sanitizeLine = (html: string) => sanitize(html, "LINE");
export const sanitizeFootnoteHtml = (html: string) => sanitize(html, "FOOTNOTE");
