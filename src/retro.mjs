// attic retro: monthly self-assessment. Rule changes are PROPOSED, never applied.
import fs from 'node:fs';
import path from 'node:path';
import { requireVault } from './config.mjs';
import { atticPath, ensureSkeleton, parseFrontmatter, writeAttic } from './vault.mjs';
import { listProposals, createProposal } from './proposals.mjs';
import { readJson } from './util.mjs';
import { sourceName } from './collect.mjs';
import { dispatch } from './notify/index.mjs';

const DAY = 86400000;

export function previousMonth(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
export function monthRange(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`잘못된 월 형식: ${month} (YYYY-MM)`);
  return { start: new Date(Number(m[1]), Number(m[2]) - 1, 1), end: new Date(Number(m[1]), Number(m[2]), 1) };
}

function loadTriages(vault) {
  const dir = atticPath(vault, 'triage');
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(dir, n), null)).filter(Boolean); } catch { return []; }
}

/** Pure computation so tests can feed fixtures. */
export function compute({ triages, proposals, teachNotes, sourcesConfigured, month, now }) {
  const { start, end } = monthRange(month);
  const inMonth = triages.filter((t) => { const d = new Date(t.generatedAt); return d >= start && d < end; });
  const perSource = {};
  const tot = { a: 0, b: 0, c: 0, d: 0, unclassified: 0 };
  for (const t of inMonth) for (const it of t.items) {
    const s = (perSource[it.source || 'unknown'] ||= { total: 0, a: 0, b: 0, c: 0, d: 0, unclassified: 0 });
    // An unknown class (older/newer triage files) counts as unclassified so the ratios never turn into NaN.
    const k = it.class in tot ? it.class : 'unclassified';
    s.total++; s[k]++; tot[k]++;
  }
  const totalItems = Object.values(tot).reduce((x, y) => x + y, 0);
  const ratios = Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, totalItems ? v / totalItems : 0]));

  // approval rate by proposal kind, among decided ones (pending proposals are not counted)
  const byKind = {};
  for (const p of proposals) {
    const d = new Date(p.createdAt);
    if (d < start || d >= end || p.status === 'pending') continue;
    const k = (byKind[p.kind] ||= { decided: 0, approved: 0 });
    k.decided++;
    if (p.status === 'approved' || p.status === 'applied') k.approved++;
  }
  for (const k of Object.values(byKind)) k.rate = k.decided ? k.approved / k.decided : null;
  const dAll = Object.values(byKind).reduce((x, k) => x + k.decided, 0);
  const aAll = Object.values(byKind).reduce((x, k) => x + k.approved, 0);

  const scores = teachNotes.map((n) => n.score).filter((x) => typeof x === 'number');
  const teach = { count: teachNotes.length, avgScore: scores.length ? scores.reduce((x, y) => x + y, 0) / scores.length : null };

  // sources with zero a/c over the last 90 days (needs >= 90 days of history, otherwise we cannot tell)
  const win = triages.filter((t) => { const d = new Date(t.generatedAt); return d >= new Date(end.getTime() - 90 * DAY) && d < end; });
  const oldest = triages.length ? Math.min(...triages.map((t) => new Date(t.generatedAt).getTime())) : Infinity;
  const coverageOk = oldest <= end.getTime() - 90 * DAY;
  const w90 = {};
  for (const t of win) for (const it of t.items) {
    const s = (w90[it.source || 'unknown'] ||= { total: 0, ac: 0 });
    s.total++; if (it.class === 'a' || it.class === 'c') s.ac++;
  }
  const silent = [];
  if (coverageOk) {
    for (const name of sourcesConfigured) {
      const s = w90[name];
      if (!s || s.ac === 0) silent.push({ source: name, items90d: s ? s.total : 0 });
    }
  }
  return { month, perSource, counts: tot, ratios, approval: { overall: dAll ? aAll / dAll : null, decided: dAll, byKind }, teach, silent, coverageOk, triageWeeks: inMonth.length };
}

export function descriptorsFrom(r) {
  const out = [];
  for (const s of r.silent) {
    out.push({ kind: 'retro-source', summary: [`출처 "${s.source}" 는 90일간 a/c 로 분류된 항목이 0건입니다 (수집 ${s.items90d}건). 구독을 끊을까요?`], payload: { op: 'remove_source', match: s.source } });
  }
  for (const [kind, k] of Object.entries(r.approval.byKind)) {
    if (k.decided >= 3 && k.rate !== null && k.rate < 0.3) {
      out.push({ kind: 'retro-criteria', summary: [`"${kind}" 제안의 승인율이 ${(k.rate * 100).toFixed(0)}% (${k.approved}/${k.decided}) 입니다. 분류/제안 기준을 조정할까요?`],
        payload: { op: 'adjust_criteria', category: kind, approvalRate: Number(k.rate.toFixed(2)), prompt: `이번 달 "${kind}" 제안이 자주 거절됐습니다. 거절된 제안(_attic/proposals/*.json 중 status=rejected, kind=${kind})을 읽고, 분류 프롬프트나 제안 조건에서 무엇을 바꾸면 좋을지 구체적인 수정안을 diff 로 제시하세요.` } });
    }
  }
  return out;
}

export function renderRetro(r, descriptors, dryRun) {
  const pct = (x) => (x === null ? '-' : `${(x * 100).toFixed(0)}%`);
  const L = [`# 월간 회고 ${r.month}`, '', `- triage 주 수: ${r.triageWeeks}`,
    `- a/b/c/d/미분류 비율: a ${pct(r.ratios.a)} / b ${pct(r.ratios.b)} / c ${pct(r.ratios.c)} / d ${pct(r.ratios.d)} / 미분류 ${pct(r.ratios.unclassified)}`,
    `- 제안 승인율: ${pct(r.approval.overall)} (결정된 ${r.approval.decided}건)`,
    `- teach 숙달 노트: ${r.teach.count}개, 평균 점수 ${r.teach.avgScore === null ? '-' : r.teach.avgScore.toFixed(1)}`,
    '', '## 출처별 항목 수', '', '| 출처 | 전체 | a | b | c | d | 미분류 |', '|---|---|---|---|---|---|---|'];
  for (const [n, s] of Object.entries(r.perSource).sort((x, y) => y[1].total - x[1].total)) L.push(`| ${n} | ${s.total} | ${s.a} | ${s.b} | ${s.c} | ${s.d} | ${s.unclassified} |`);
  L.push('', '## 범주별 승인율', '');
  const kinds = Object.entries(r.approval.byKind);
  if (!kinds.length) L.push('- 결정된 제안 없음');
  for (const [k, v] of kinds) L.push(`- ${k}: ${pct(v.rate)} (${v.approved}/${v.decided})`);
  L.push('', '## 다음 달 제안', '');
  if (!r.coverageOk) L.push('- 90일치 기록이 아직 없어 출처 정리 제안은 보류합니다.');
  if (!descriptors.length) L.push('- 제안 없음');
  for (const d of descriptors) L.push(`- (${d.kind}) ${d.summary[0]}`);
  if (dryRun) L.push('', '(dry-run: 제안을 저장하지 않았습니다)');
  return L.join('\n') + '\n';
}

export async function retro(ctx, { month, dryRun = false, now = new Date() } = {}) {
  const vault = requireVault(ctx);
  ensureSkeleton(vault);
  month = month || previousMonth(now);
  const tdir = atticPath(vault, 'teach');
  const teachNotes = [];
  try { for (const n of fs.readdirSync(tdir).filter((x) => x.endsWith('.md'))) teachNotes.push(parseFrontmatter(fs.readFileSync(path.join(tdir, n), 'utf8')).data); } catch { /* none */ }
  const r = compute({ triages: loadTriages(vault), proposals: listProposals(vault), teachNotes, sourcesConfigured: (ctx.config.sources || []).map(sourceName), month, now });
  const descriptors = descriptorsFrom(r);
  const file = writeAttic(vault, `retro/${month}.md`, renderRetro(r, descriptors, dryRun));
  let created = [];
  if (!dryRun && descriptors.length) {
    created = descriptors.map((d) => createProposal(vault, { ...d, source: 'retro' }, now).proposal);
    await dispatch(ctx, { title: `brain-attic 월간 회고 ${month}`, text: `제안 ${created.length}건이 승인을 기다립니다. 회고: ${file}` }, created);
  }
  return { ...r, file, proposals: created.map((p) => p.id) };
}
