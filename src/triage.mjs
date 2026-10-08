// attic triage: this week's inbox + recently modified vault notes -> a/b/c via an LLM runner.
//   a = skim, just be aware   b = no awareness needed (the system should apply it)   c = invest time: read deeply, write, explain
import fs from 'node:fs';
import path from 'node:path';
import { requireVault } from './config.mjs';
import { atticPath, ensureSkeleton, listRecentMd, parseFrontmatter, projectsFileOf, readProjects, writeAttic, writeAtticJson } from './vault.mjs';
import { isoWeek, weekStart, truncate, dateStr } from './util.mjs';
import { runJSON, llmOpts, wrapUntrusted, UNTRUSTED_NOTICE } from './llm.mjs';
import { parseInbox } from './collect.mjs';

const BATCH = 40;
/** Items sent to the LLM per week. Notes the user saved go first, then newest inbox items. */
export const MAX_ITEMS = 120;
export const SHEET_LIST_MAX = 15;
export const CLASSES = ['a', 'b', 'c', 'd', 'unclassified'];

export function gatherItems(ctx, week, now = new Date()) {
  const vault = requireVault(ctx);
  const start = weekStart(week);
  const end = new Date(start.getTime() + 7 * 86400000);
  const items = [];
  const inboxDir = atticPath(vault, 'inbox');
  let names = [];
  try { names = fs.readdirSync(inboxDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)); } catch { /* none */ }
  for (const n of names) {
    const d = new Date(n.slice(0, 10) + 'T00:00:00');
    if (d >= start && d < end) items.push(...parseInbox(fs.readFileSync(path.join(inboxDir, n), 'utf8'), n.slice(0, 10)));
  }
  // vault notes: last 7 days when this is the current week, else that week's range
  const isCurrent = week === isoWeek(now);
  const sinceMs = isCurrent ? now.getTime() - 7 * 86400000 : start.getTime();
  const untilMs = isCurrent ? Infinity : end.getTime();
  for (const folder of ctx.config.triage?.include || []) {
    const dir = path.isAbsolute(folder) ? folder : path.join(vault, folder);
    for (const { file } of listRecentMd(dir, { sinceMs, untilMs })) {
      let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const { data, body } = parseFrontmatter(text);
      const title = data.title || path.basename(file, '.md');
      items.push({
        title: String(title), url: data.url ? String(data.url) : '', source: 'vault',
        summary: String(data.summary || body.replace(/\s+/g, ' ').trim().slice(0, 300)),
        tags: Array.isArray(data.tags) ? data.tags : (data.tags ? [String(data.tags)] : []),
        date: dateStr(new Date(fs.statSync(file).mtimeMs)), file: path.relative(vault, file),
      });
    }
  }
  // Duplicates (same URL, or same source+title) are kept but flagged: they become d without an LLM call.
  const seen = new Map();
  return items.map((it, i) => {
    const k = it.url || `${it.source}:${it.title}`;
    const dupOf = seen.get(k);
    if (!dupOf) seen.set(k, `i${i + 1}`);
    return { ...it, id: `i${i + 1}`, ...(dupOf ? { dupOf } : {}) };
  });
}

function buildPrompt(batch, projects) {
  const list = batch.map((it) => JSON.stringify({ id: it.id, title: truncate(it.title, 120), url: it.url, summary: truncate(it.summary, 240), tags: it.tags || [] })).join('\n');
  return [
    '너는 개인 지식 시스템의 주간 분류기다. 아래 항목을 각각 a/b/c/d 중 하나로 분류한다.',
    '- a: 가볍게 읽고 인지만 한다. 존재를 아는 것만으로 쓸모가 있다.',
    '- b: 인지가 필요 없다. 시스템이 자동으로 적용하면 된다(예: 도구 업데이트).',
    '- c: 시간을 들여 깊게 읽고, 쓰고, 설명해 볼 것. 이 경우 minutes(예상 소요 분, 정수)를 반드시 적는다.',
    '- d: 버릴 것. 다른 항목과 사실상 같은 내용(중복)이거나, 프로젝트 목록 어디에도 쓸모가 없고 알아 둘 가치도 없는 것(광고·행사 홍보·잡담 등).',
    `연결 프로젝트(project)는 아래 목록의 줄 하나를 그대로 적거나, 없으면 null.`,
    '프로젝트 목록:', projects.length ? projects.map((p) => `- ${p}`).join('\n') : '(없음)',
    `출력 스키마: {"items":[{"id":"입력의 id","class":"a|b|c|d","project":"목록의 줄 또는 null","reason":"이유 한 줄","minutes":정수(c 일 때만)}]}`,
    UNTRUSTED_NOTICE, wrapUntrusted(list),
  ].join('\n');
}

export function validateResponse(obj) {
  if (!obj || typeof obj !== 'object' || !Array.isArray(obj.items)) throw new Error('items 배열이 없음');
  return true;
}

/** Validate one classified item; returns normalized item or null. */
export function normalizeItem(raw, projects) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') return null;
  const cls = String(raw.class || '').toLowerCase();
  if (!['a', 'b', 'c', 'd'].includes(cls)) return null;
  const reason = typeof raw.reason === 'string' ? raw.reason.trim().slice(0, 200) : '';
  if (!reason) return null;
  const out = { id: raw.id, class: cls, reason, project: projects.includes(raw.project) ? raw.project : null };
  if (cls === 'c') {
    const m = Number(raw.minutes);
    if (!Number.isFinite(m) || m <= 0) return null;
    out.minutes = Math.round(m);
  }
  return out;
}

/** Cut c to the weekly budget; overflow is demoted to a. */
export function applyBudget(items, weeklyMinutes) {
  let used = 0;
  const cs = items.filter((i) => i.class === 'c')
    .sort((x, y) => (x.project ? 0 : 1) - (y.project ? 0 : 1) || x.minutes - y.minutes);
  const keep = new Set();
  for (const c of cs) { if (used + c.minutes <= weeklyMinutes) { used += c.minutes; keep.add(c.id); } }
  let demoted = 0;
  for (const it of items) {
    if (it.class === 'c' && !keep.has(it.id)) {
      it.demotedFrom = 'c'; it.demotedMinutes = it.minutes; delete it.minutes; it.class = 'a';
      it.reason = `${it.reason} (주간 시간 예산 ${weeklyMinutes}분 초과로 c -> a 강등)`;
      demoted++;
    }
  }
  return { usedMinutes: used, demoted };
}

export async function triage(ctx, { week, now = new Date() } = {}) {
  const vault = requireVault(ctx);
  ensureSkeleton(vault);
  week = week || isoWeek(now);
  const gathered = gatherItems(ctx, week, now);
  const dups = gathered.filter((it) => it.dupOf);
  const all = gathered.filter((it) => !it.dupOf);
  const maxItems = ctx.config.triage?.maxItems ?? MAX_ITEMS;
  const ranked = [...all].sort((x, y) => (x.source === 'vault' ? 0 : 1) - (y.source === 'vault' ? 0 : 1)
    || String(y.published || y.date || '').localeCompare(String(x.published || x.date || '')));
  const items = ranked.slice(0, maxItems);
  const overflow = ranked.slice(maxItems);
  const projects = readProjects(projectsFileOf(ctx));
  const budget = ctx.config.triage?.weeklyMinutes ?? 180;
  const opts = llmOpts(ctx);
  const classified = new Map();
  const errors = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    try {
      const obj = await runJSON({ prompt: buildPrompt(batch, projects), validate: validateResponse, untrusted: true, ...opts });
      const ids = new Set(batch.map((b) => b.id));
      for (const raw of obj.items) {
        const n = normalizeItem(raw, projects);
        if (n && ids.has(n.id) && !classified.has(n.id)) classified.set(n.id, n);
      }
    } catch (e) { errors.push(e.message); ctx.log.warn(`triage: 분류 실패 -> 미분류 처리 (${e.message})`); }
  }
  const result = items.map((it) => {
    const c = classified.get(it.id);
    const base = { id: it.id, title: it.title, url: it.url, source: it.source, date: it.date, ...(it.file ? { file: it.file } : {}) };
    return c ? { ...base, class: c.class, project: c.project, reason: c.reason, ...(c.minutes ? { minutes: c.minutes } : {}) }
      : { ...base, class: 'unclassified', project: null, reason: '분류하지 못함' };
  });
  for (const it of dups) {
    result.push({ id: it.id, title: it.title, url: it.url, source: it.source, date: it.date, ...(it.file ? { file: it.file } : {}), class: 'd', project: null, reason: '같은 링크가 이번 주에 이미 들어와 있는 중복' });
  }
  for (const it of overflow) {
    result.push({ id: it.id, title: it.title, url: it.url, source: it.source, date: it.date, class: 'unclassified', project: null, reason: `주간 상한 ${maxItems}건 초과 — 분류하지 않음` });
  }
  const { usedMinutes, demoted } = applyBudget(result, budget);
  const counts = Object.fromEntries(CLASSES.map((k) => [k, result.filter((r) => r.class === k).length]));
  const out = { week, generatedAt: now.toISOString(), weeklyMinutes: budget, usedMinutes, demoted, counts, errors, overflow: overflow.length, items: result };
  writeAtticJson(vault, `triage/${week}.json`, out);
  writeAttic(vault, `triage/${week}.md`, renderTriage(out));
  return out;
}

export function renderTriage(t) {
  const L = [`# Triage ${t.week}`, '', `- 항목 ${t.items.length}개: a ${t.counts.a} / b ${t.counts.b} / c ${t.counts.c} / 미분류 ${t.counts.unclassified}`,
    `- c 예산: ${t.usedMinutes}/${t.weeklyMinutes}분${t.demoted ? `, 예산 초과로 a 로 강등 ${t.demoted}건` : ''}`];
  if (t.overflow) L.push(`- 주간 상한을 넘어 분류하지 않은 항목 ${t.overflow}건 (config.triage.maxItems 로 조정)`);
  if (t.errors.length) L.push(`- 러너 오류 ${t.errors.length}건 (해당 항목은 미분류): ${t.errors[0]}`);
  const names = { c: 'c — 깊게 읽고 쓰고 설명', a: 'a — 인지만', b: 'b — 자동 적용 대상', d: 'd — 버릴 후보(중복·쓸모없음)', unclassified: '미분류' };
  for (const k of ['c', 'a', 'b', 'd', 'unclassified']) {
    const rows = t.items.filter((i) => i.class === k);
    if (!rows.length) continue;
    L.push('', `## ${names[k]} (${rows.length})`);
    // a and unclassified can be long; the sheet is for a 10-minute weekly review, so show the top part only.
    const shown = k === 'a' || k === 'd' || k === 'unclassified' ? rows.slice(0, SHEET_LIST_MAX) : rows;
    for (const r of shown) {
      const title = r.title.replace(/[\[\]]/g, '');
      // Vault notes have no URL: link them as Obsidian wiki links so they open in the vault.
      const link = r.url ? `[${title}](${r.url})` : r.file ? `[[${r.file.replace(/\.md$/, '')}|${title}]]` : title;
      L.push(`- ${link} — ${r.reason}${r.project ? ` · 프로젝트: ${r.project}` : ''}${r.minutes ? ` · 약 ${r.minutes}분` : ''}${r.source ? ` · ${r.source}` : ''}`);
    }
    if (shown.length < rows.length) L.push(`- 외 ${rows.length - shown.length}건 (전체는 같은 폴더의 ${t.week}.json)`);
  }
  return L.join('\n') + '\n';
}
