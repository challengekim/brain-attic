// Minimal RSS 2.0 / Atom 1.0 parser. No dependencies; tolerant, not a validator.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
function cdataOrText(raw) {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(raw);
  return m ? m[1] : decodeEntities(raw);
}
export function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}
function tag(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
  const m = re.exec(block);
  return m ? cdataOrText(m[1]).trim() : '';
}
function attr(tagText, name) {
  const m = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tagText);
  return m ? decodeEntities(m[2] ?? m[3]) : '';
}
function atomLink(block) {
  const links = [...block.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
  const alt = links.find((l) => /rel\s*=\s*["']alternate["']/i.test(l)) || links.find((l) => !/rel\s*=/i.test(l)) || links[0];
  return alt ? attr(alt, 'href') : '';
}

/** @returns {{title:string,url:string,summary:string,published:string}[]} */
export function parseFeed(xml) {
  const items = [];
  const isAtom = /<feed\b/i.test(xml) && !/<rss\b/i.test(xml);
  const re = isAtom ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  for (const m of xml.matchAll(re)) {
    const b = m[1];
    let title = stripTags(tag(b, 'title'));
    let url = isAtom ? atomLink(b) : tag(b, 'link');
    if (!url && !isAtom) url = tag(b, 'guid');
    if (!url && isAtom) url = tag(b, 'id');
    const raw = tag(b, isAtom ? 'summary' : 'description') || tag(b, 'content') || tag(b, 'content:encoded') || tag(b, 'content');
    const summary = stripTags(raw).slice(0, 500);
    const published = tag(b, isAtom ? 'published' : 'pubDate') || tag(b, 'updated') || tag(b, 'dc:date');
    if (!url || !title) continue;
    items.push({ title, url: url.trim(), summary, published });
  }
  return items;
}
