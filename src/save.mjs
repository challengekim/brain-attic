// attic save: manual capture. A link and/or a memo -> <vault>/_attic/saved/YYYY-MM-DD-<slug>.md (frontmatter note).
// No network: the link is stored as given (http/https only); triage reads the note like any other vault note
// and ranks it ahead of collected feed items. Writes only under _attic/ (the vault write gate).
import fs from 'node:fs';
import crypto from 'node:crypto';
import { requireVault } from './config.mjs';
import { atticPath, ensureSkeleton, stringifyFrontmatter, writeAttic } from './vault.mjs';
import { dateStr, normalizeUrl, truncate } from './util.mjs';

export const SAVED_DIR = 'saved';

function slugOf(s) {
  const base = String(s).toLowerCase().replace(/^https?:\/\//, '').replace(/[^a-z0-9가-힣]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  return base || 'note';
}

/** Split positional args: an http(s) URL becomes the link, the rest is the memo. */
export function parseSaveArgs(positional = [], { note, title } = {}) {
  let url = '';
  const words = [];
  for (const a of positional) {
    if (!url && /^https?:\/\/\S+$/i.test(a)) url = a; else words.push(a);
  }
  const memo = [note, words.join(' ')].filter((x) => x && String(x).trim()).join('\n').trim();
  return { url, memo, title: title ? String(title).trim() : '' };
}

export function save(ctx, { url = '', memo = '', title = '', tags = [], now = new Date() } = {}) {
  const vault = requireVault(ctx);
  if (!url && !memo) throw new Error('저장할 링크나 메모가 없습니다: attic save <URL> [메모] 또는 attic save --note "메모"');
  if (url && !/^https?:\/\//i.test(url)) throw new Error('링크는 http(s) 주소만 저장합니다');
  ensureSkeleton(vault);
  const link = url ? normalizeUrl(url) : '';
  const t = title || (memo ? truncate(memo.split('\n')[0], 80) : link);
  const day = dateStr(now);
  const hash = crypto.createHash('sha256').update(`${link}\n${memo}\n${now.toISOString()}`).digest('hex').slice(0, 6);
  const rel = `${SAVED_DIR}/${day}-${slugOf(title || memo || link)}-${hash}.md`;
  const data = { title: t, ...(link ? { url: link } : {}), ...(memo ? { summary: truncate(memo.replace(/\s+/g, ' '), 300) } : {}), source: 'attic save', saved_at: now.toISOString(), ...(tags.length ? { tags } : {}) };
  const body = `\n${memo ? memo + '\n' : ''}${link ? `\n<${link}>\n` : ''}`;
  const file = writeAttic(vault, rel, stringifyFrontmatter(data, body));
  return { file, rel, title: t, url: link };
}

/** Folder triage always reads (in addition to config.triage.include). */
export function savedDir(vault) {
  const d = atticPath(vault, SAVED_DIR);
  return fs.existsSync(d) ? d : null;
}
