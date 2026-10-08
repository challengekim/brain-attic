// attic radar: snapshot + diff of OpenRouter models and the kie.ai doc index.
import fs from 'node:fs';
import { requireVault } from './config.mjs';
import { atticPath, ensureSkeleton, writeAttic, writeAtticJson } from './vault.mjs';
import { dateStr, fetchText, readJson, redactUrls, timeStr } from './util.mjs';
import * as or from './sources/openrouter.mjs';
import * as kie from './sources/kie.mjs';

export const EVENT_DAYS = 45;

function loadEvents(vault) { return readJson(atticPath(vault, 'radar', 'events.json'), []); }
export function recentEvents(vault, days = 7, now = new Date()) {
  const cutoff = dateStr(new Date(now.getTime() - days * 86400000));
  return loadEvents(vault).filter((e) => e.date >= cutoff);
}
function saveEvents(vault, events, now) {
  const cutoff = dateStr(new Date(now.getTime() - EVENT_DAYS * 86400000));
  const seen = new Set();
  const kept = events.filter((e) => e.date >= cutoff && !seen.has(e.key) && seen.add(e.key));
  writeAtticJson(vault, 'radar/events.json', kept);
}
const fmtPct = (c) => (Number.isFinite(c) ? `${(c * 100).toFixed(0)}%` : '무료->유료');
const fmtPrice = (p) => (p === null ? '?' : `$${(p * 1e6).toFixed(4).replace(/\.?0+$/, '')}/M`);

async function runSource(ctx, { name, file, url, fetchSnap, diff, now }) {
  const vault = ctx.vault;
  const rel = `radar/${file}`;
  const prev = readJson(atticPath(vault, rel), null);
  let cur;
  try { cur = await fetchSnap(url); }
  catch (e) { const msg = redactUrls(e.message); ctx.log.warn(`radar 건너뜀: ${name} (${msg})`); return { name, status: 'skipped', error: msg }; }
  if (!prev) { writeAtticJson(vault, rel, cur); return { name, status: 'baseline', count: cur.count }; }
  const d = diff(prev, cur);
  writeAtticJson(vault, rel, cur);
  return { name, status: 'diff', count: cur.count, diff: d };
}

export async function radar(ctx, { now = new Date() } = {}) {
  const vault = requireVault(ctx);
  ensureSkeleton(vault);
  const r = ctx.config.radar || {};
  const today = dateStr(now);
  const events = loadEvents(vault);
  const results = [];

  results.push(await runSource(ctx, {
    name: 'openrouter', file: 'openrouter-latest.json', url: r.openrouterUrl, now,
    fetchSnap: async (u) => or.toSnapshot(JSON.parse(await fetchText(ctx, u, { timeoutMs: 30000, source: 'openrouter' })), now),
    diff: (p, c) => or.diffSnapshots(p, c, r.priceThreshold ?? 0.2),
  }));
  results.push(await runSource(ctx, {
    name: 'kie', file: 'kie-latest.json', url: r.kieLlmsUrl, now,
    fetchSnap: async (u) => kie.toSnapshot(await fetchText(ctx, u, { timeoutMs: 30000, source: 'kie' }), now),
    diff: kie.diffSnapshots,
  }));

  for (const res of results) {
    if (res.status !== 'diff') continue;
    if (res.name === 'openrouter') {
      for (const m of res.diff.added) events.push({ key: `or:new:${m.id}`, date: today, source: 'openrouter', kind: 'new', id: m.id, name: m.name, capabilities: m.nonText, detail: `신규 모델 (출력 ${m.out.join('/') || '?'})` });
      for (const c of res.diff.priceChanges) events.push({ key: `or:price:${c.id}:${c.field}:${c.to}`, date: today, source: 'openrouter', kind: c.change < 0 ? 'price_drop' : 'price_rise', id: c.id, name: c.name, detail: `${c.field} ${fmtPrice(c.from)} -> ${fmtPrice(c.to)} (${fmtPct(c.change)})` });
      for (const m of res.diff.newModalities) events.push({ key: `or:mod:${m.id}:${m.gained.join(',')}`, date: today, source: 'openrouter', kind: 'modality', id: m.id, name: m.name, capabilities: m.gained, detail: `새 출력 모달리티: ${m.gained.join(', ')}` });
    } else {
      for (const d of res.diff.added) events.push({ key: `kie:${d.url}`, date: today, source: 'kie', kind: 'kie_new', id: d.url, name: d.title, capabilities: kie.capabilitiesOf(`${d.category} ${d.title}`), detail: `새 문서: ${d.category ? d.category + ' > ' : ''}${d.title}` });
    }
  }
  saveEvents(vault, events, now);

  const md = renderReport(results, today, timeStr(now));
  const rel = `radar/${today}.md`;
  const file = atticPath(vault, rel);
  const prevMd = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') + '\n' : `# Radar ${today}\n\n`;
  writeAttic(vault, rel, prevMd + md);
  return { date: today, file, results };
}

export function renderReport(results, today, time) {
  const out = [`## ${time} 실행`, ''];
  for (const r of results) {
    out.push(`### ${r.name}`);
    if (r.status === 'skipped') { out.push(`- 건너뜀: ${r.error} (이전 스냅샷은 그대로 둠)`, ''); continue; }
    if (r.status === 'baseline') { out.push(`- 기준선 저장 (${r.count}개). 다음 실행부터 변화를 비교합니다.`, ''); continue; }
    const d = r.diff;
    if (r.name === 'openrouter') {
      const n = d.added.length + d.priceChanges.length + d.newModalities.length;
      out.push(`- 변화 ${n}건 (신규 ${d.added.length} / 가격 ${d.priceChanges.length} / 새 모달리티 ${d.newModalities.length})`);
      for (const m of d.added.slice(0, 50)) out.push(`  - 신규: \`${m.id}\` — 출력 ${m.out.join('/') || '?'}, 입력가 ${fmtPrice(m.prompt)}, 출력가 ${fmtPrice(m.completion)}`);
      for (const c of d.priceChanges.slice(0, 50)) out.push(`  - 가격: \`${c.id}\` ${c.field} ${fmtPrice(c.from)} -> ${fmtPrice(c.to)} (${fmtPct(c.change)})`);
      for (const m of d.newModalities) out.push(`  - 모달리티: \`${m.id}\` 새 출력 ${m.gained.join(', ')}`);
    } else {
      out.push(`- 새로 문서화된 항목 ${d.added.length}건`);
      for (const a of d.added.slice(0, 50)) out.push(`  - ${a.category ? a.category + ' > ' : ''}${a.title} (${a.url})`);
    }
    out.push('');
  }
  return out.join('\n');
}

export function changeCount(res) {
  if (res.status !== 'diff') return 0;
  const d = res.diff;
  return res.name === 'openrouter' ? d.added.length + d.priceChanges.length + d.newModalities.length : d.added.length;
}
