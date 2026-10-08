// attic collect: sources -> _attic/inbox/YYYY-MM-DD.md, deduped by a 60-day URL ledger.
import fs from 'node:fs';
import { requireVault } from './config.mjs';
import { atticPath, ensureSkeleton, writeAttic, writeAtticJson } from './vault.mjs';
import { dateStr, fetchText, normalizeUrl, readJson, redactUrls } from './util.mjs';
import { parseFeed } from './sources/feed.mjs';

export const SEEN_DAYS = 60;
/** First run (empty ledger): only this many recent days, so a new install does not flood the inbox. */
export const FIRST_RUN_DAYS = 7;
/** Per source per run. Feeds like HN carry dozens of items; the inbox should stay readable. */
export const MAX_PER_SOURCE = 20;

export function sourceUrl(src) {
  if (src.type === 'github' || (src.repo && !src.url)) return `https://github.com/${src.repo}/releases.atom`;
  return src.url;
}
export function sourceName(src) { return src.name || (src.repo ? `${src.repo} releases` : (() => { try { return new URL(src.url).hostname; } catch { return src.url; } })()); }

export function loadSeen(vault, now = new Date()) {
  const raw = readJson(atticPath(vault, 'state', 'seen.json'), {});
  const cutoff = now.getTime() - SEEN_DAYS * 86400000;
  return Object.fromEntries(Object.entries(raw).filter(([, d]) => new Date(d).getTime() >= cutoff));
}

export function formatEntry(item, source) {
  const lines = [`### [${item.title.replace(/[\[\]]/g, '')}](${item.url})`, `- source: ${source}`];
  if (item.published) lines.push(`- published: ${item.published}`);
  if (item.summary) lines.push(`> ${item.summary.replace(/\s+/g, ' ')}`);
  return lines.join('\n') + '\n';
}

/** Parse an inbox markdown file back into items. */
export function parseInbox(text, date) {
  const items = [];
  for (const block of text.split(/^(?=### \[)/m)) {
    const h = /^### \[(.*)\]\((.+)\)\s*$/m.exec(block);
    if (!h) continue;
    const src = /^- source: (.*)$/m.exec(block);
    const pub = /^- published: (.*)$/m.exec(block);
    const sum = /^> (.*)$/m.exec(block);
    items.push({ title: h[1], url: h[2], source: src ? src[1] : 'unknown', published: pub ? pub[1] : '', summary: sum ? sum[1] : '', date });
  }
  return items;
}

export async function collect(ctx, { now = new Date() } = {}) {
  const vault = requireVault(ctx);
  ensureSkeleton(vault);
  const sources = ctx.config.sources || [];
  const seen = loadSeen(vault, now);
  const firstRun = Object.keys(seen).length === 0;
  const c = ctx.config.collect || {};
  const maxPerSource = c.maxPerSource ?? MAX_PER_SOURCE;
  const firstRunCutoff = now.getTime() - (c.firstRunDays ?? FIRST_RUN_DAYS) * 86400000;
  const today = dateStr(now);
  const res = { added: 0, duplicates: 0, errors: [], perSource: {} };
  const blocks = [];
  for (const src of sources) {
    const url = sourceUrl(src);
    const name = sourceName(src);
    if (!url) { res.errors.push({ source: name, error: 'url/repo 없음' }); continue; }
    try {
      const xml = await fetchText(ctx, url, { timeoutMs: 20000, source: name });
      let added = 0;
      let skipped = 0;
      for (const it of parseFeed(xml)) {
        const key = normalizeUrl(it.url);
        if (seen[key]) { res.duplicates++; continue; }
        // Mark as seen even when skipped, so old items do not come back next run.
        seen[key] = today;
        const pub = it.published ? Date.parse(it.published) : NaN;
        if ((firstRun && Number.isFinite(pub) && pub < firstRunCutoff) || added >= maxPerSource) { skipped++; continue; }
        blocks.push(formatEntry({ ...it, url: key }, name));
        added++;
      }
      res.perSource[name] = added;
      res.skipped = (res.skipped || 0) + skipped;
      res.added += added;
    } catch (e) {
      const msg = redactUrls(e.message);
      res.errors.push({ source: name, error: msg });
      ctx.log.warn(`수집 건너뜀: ${name} (${msg})`);
    }
  }
  if (blocks.length) {
    const file = atticPath(vault, 'inbox', `${today}.md`);
    const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : `# Inbox ${today}\n\n`;
    writeAttic(vault, `inbox/${today}.md`, prev + blocks.join('\n') + '\n');
  }
  writeAtticJson(vault, 'state/seen.json', seen);
  return res;
}
