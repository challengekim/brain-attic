// attic triage: this week's inbox + manual saves (_attic/saved) + recently modified vault notes -> a/b/c/d via an LLM runner.
//   a = skim, just be aware   b = no awareness needed (the system should apply it)   c = invest time: read deeply, write, explain
//   d = drop (duplicate or useless)
import fs from 'node:fs';
import path from 'node:path';
import { requireVault } from './config.mjs';
import { atticPath, ensureSkeleton, listRecentMd, parseFrontmatter, projectsFileOf, readProjects, writeAttic, writeAtticJson } from './vault.mjs';
import { isoWeek, weekStart, truncate, dateStr } from './util.mjs';
import { runJSON, llmOpts, wrapUntrusted, UNTRUSTED_NOTICE } from './llm.mjs';
import { parseInbox } from './collect.mjs';
import { savedDir } from './save.mjs';
import { computeUsage, BACKLINK_HOT } from './usage.mjs';

const BATCH = 40; // items per model call. There is no overall cap unless config.triage.maxItems is set.
export const DEFAULT_RATIOS = { a: 0.30, b: 0.45, c: 0.05, d: 0.20 };
export const SHEET_LIST_MAX = 15;
export const CLASSES = ['a', 'b', 'c', 'd', 'unclassified'];

export function gatherItems(ctx, week, now = new Date()) {
  const vault = requireVault(ctx);
  const start = weekStart(week);
  const end = new Date(start.getTime() + 7 * 86400000);
  const items = [];
  // vault notes: last 7 days when this is the current week, else that week's range
  const isCurrent = week === isoWeek(now);
  const sinceMs = isCurrent ? now.getTime() - 7 * 86400000 : start.getTime();
  const untilMs = isCurrent ? Infinity : end.getTime();
  const readNotes = (dir, source) => {
    for (const { file } of listRecentMd(dir, { sinceMs, untilMs })) {
      let text; try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
      const { data, body } = parseFrontmatter(text);
      const title = data.title || path.basename(file, '.md');
      items.push({
        title: String(title), url: data.url ? String(data.url) : '', source,
        summary: String(data.summary || body.replace(/\s+/g, ' ').trim().slice(0, 300)),
        tags: Array.isArray(data.tags) ? data.tags : (data.tags ? [String(data.tags)] : []),
        date: dateStr(new Date(fs.statSync(file).mtimeMs)), file: path.relative(vault, file),
      });
    }
  };
  // Manual saves first: when the same link also arrived through a feed, the one the user saved is kept.
  const saved = savedDir(vault);
  if (saved) readNotes(saved, 'saved');
  const inboxDir = atticPath(vault, 'inbox');
  let names = [];
  try { names = fs.readdirSync(inboxDir).filter((n) => /^\d{4}-\d{2}-\d{2}\.md$/.test(n)); } catch { /* none */ }
  for (const n of names) {
    const d = new Date(n.slice(0, 10) + 'T00:00:00');
    if (d >= start && d < end) items.push(...parseInbox(fs.readFileSync(path.join(inboxDir, n), 'utf8'), n.slice(0, 10)));
  }
  for (const folder of ctx.config.triage?.include || []) {
    const dir = path.isAbsolute(folder) ? folder : path.join(vault, folder);
    readNotes(dir, 'vault');
  }
  // Duplicates (same URL, or same source+title for feed items) are kept but flagged: they become d without an LLM call.
  // A note without a URL is identified by its file, never by its (possibly shortened) title.
  const seen = new Map();
  return items.map((it, i) => {
    const k = it.url || (it.file ? `file:${it.file}` : `${it.source}:${it.title}`);
    const dupOf = seen.get(k);
    if (!dupOf) seen.set(k, `i${i + 1}`);
    return { ...it, id: `i${i + 1}`, ...(dupOf ? { dupOf } : {}) };
  });
}

/** Validate config ratios: four numbers >= 0 that sum to 1 (+-0.01). Anything else -> defaults (reason returned). */
export function normalizeRatios(raw) {
  if (raw === undefined || raw === null) return { ratios: { ...DEFAULT_RATIOS }, warning: null };
  const r = {};
  for (const k of ['a', 'b', 'c', 'd']) {
    const v = Number(raw[k]);
    if (!Number.isFinite(v) || v < 0 || v > 1) return { ratios: { ...DEFAULT_RATIOS }, warning: `triage.targetRatios.${k} 가 올바르지 않아 기본값을 씁니다` };
    r[k] = v;
  }
  const sum = r.a + r.b + r.c + r.d;
  if (Math.abs(sum - 1) > 0.01) return { ratios: { ...DEFAULT_RATIOS }, warning: `triage.targetRatios 의 합이 1 이 아니어서(${sum.toFixed(2)}) 기본값을 씁니다` };
  return { ratios: r, warning: null };
}

const pct = (x) => `${Math.round(x * 100)}%`;

/** Actual vs expected ratio over the items that got a class a-d (미분류 excluded). */
export function ratioReport(items, target) {
  const n = items.filter((i) => ['a', 'b', 'c', 'd'].includes(i.class)).length;
  const rows = {};
  for (const k of ['a', 'b', 'c', 'd']) {
    const count = items.filter((i) => i.class === k).length;
    rows[k] = { count, actual: n ? count / n : 0, target: target[k] };
  }
  return { classified: n, rows };
}

function buildPrompt(batch, projects, ratios, usage) {
  const list = batch.map((it) => {
    const u = usage?.get(it.id);
    return JSON.stringify({ id: it.id, title: truncate(it.title, 120), url: it.url, summary: truncate(it.summary, 240), tags: it.tags || [],
      ...(u && (u.backlinks || u.projects) ? { usage: { backlinks: u.backlinks, projects: u.projects } } : {}) });
  }).join('\n');
  return [
    '너는 개인 지식 시스템의 주간 분류기다. 아래 항목을 각각 a/b/c/d 중 하나로 분류한다.',
    '- a: 가볍게 읽고 인지만 한다. 존재를 아는 것만으로 쓸모가 있다.',
    '- b: 인지가 필요 없다. 시스템이 자동으로 적용하면 된다(예: 도구 업데이트).',
    '- c: 시간을 들여 깊게 읽고, 쓰고, 설명해 볼 것. 이 경우 minutes(예상 소요 분, 정수)를 반드시 적는다.',
    '- d: 버릴 것. 다른 항목과 사실상 같은 내용(중복)이거나, 프로젝트 목록 어디에도 쓸모가 없고 알아 둘 가치도 없는 것(광고·행사 홍보·잡담 등).',
    '판단 기준: 이번 주에 쓸 데가 있는가, 아래 프로젝트 중 어디에 붙는가. 이번 주에 쓸 데가 있고 프로젝트에 붙으면 c 또는 b 쪽으로, 쓸 데가 없으면 a 또는 d 쪽으로 기운다.',
    `사용 신호: 항목의 usage.backlinks 는 볼트의 다른 노트가 이 노트를 [[링크]] 한 수, usage.projects 는 내 프로젝트 저장소 중 이 항목의 제목·파일명·링크를 언급한 프로젝트 수다. usage 가 없으면 둘 다 0 이다.`,
    `둘 이상의 프로젝트(usage.projects >= 2)에서 쓰이거나 자주 링크되는(usage.backlinks >= ${BACKLINK_HOT}) 지식은 내 것으로 만들 가치가 크다 — c(내 것으로 만들 것) 후보로 먼저 본다. 신호가 없다고 불리하게 보지는 않는다(새로 들어온 항목은 아직 쓰이지 않았을 뿐이다).`,
    `기대 비율(참고만): a ${pct(ratios.a)} / b ${pct(ratios.b)} / c ${pct(ratios.c)} / d ${pct(ratios.d)}. 이 비율을 맞추려고 억지로 분류하지 않는다. 항목 하나하나를 기준대로 판단하고, 비율은 한쪽으로 심하게 쏠렸을 때 다시 생각해 보는 눈금으로만 쓴다.`,
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
  // Caps exist only when the user set them (backward compatible); the default classifies everything.
  const posNum = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 && v !== null && v !== '' ? Number(v) : null);
  const maxItems = posNum(ctx.config.triage?.maxItems);
  const own = (it) => (it.source === 'saved' || it.source === 'vault' ? 0 : 1); // what the user saved goes first
  const ranked = [...all].sort((x, y) => own(x) - own(y)
    || String(y.published || y.date || '').localeCompare(String(x.published || x.date || '')));
  const items = maxItems ? ranked.slice(0, maxItems) : ranked;
  const overflow = maxItems ? ranked.slice(maxItems) : [];
  const projects = readProjects(projectsFileOf(ctx));
  const wm = ctx.config.triage?.weeklyMinutes; // 0 is a real (strict) budget; unset/invalid = no budget
  const budget = wm !== null && wm !== undefined && wm !== '' && Number.isFinite(Number(wm)) && Number(wm) >= 0 ? Number(wm) : null;
  const { ratios: targetRatios, warning: ratioWarning } = normalizeRatios(ctx.config.triage?.targetRatios);
  if (ratioWarning) ctx.log.warn(`triage: ${ratioWarning}`);
  let usage = new Map();
  try { usage = computeUsage(ctx, items, { projectLines: projects }); } catch (e) { ctx.log.warn(`triage: 사용 신호 계산 실패 -> 신호 없이 분류 (${e.message})`); }
  const opts = llmOpts(ctx);
  const classified = new Map();
  const errors = [];
  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);
    try {
      const obj = await runJSON({ prompt: buildPrompt(batch, projects, targetRatios, usage), validate: validateResponse, untrusted: true, ...opts });
      const ids = new Set(batch.map((b) => b.id));
      for (const raw of obj.items) {
        const n = normalizeItem(raw, projects);
        if (n && ids.has(n.id) && !classified.has(n.id)) classified.set(n.id, n);
      }
    } catch (e) { errors.push(e.message); ctx.log.warn(`triage: 분류 실패 -> 미분류 처리 (${e.message})`); }
  }
  const result = items.map((it) => {
    const c = classified.get(it.id);
    const u = usage.get(it.id);
    const base = { id: it.id, title: it.title, url: it.url, source: it.source, date: it.date, ...(it.file ? { file: it.file } : {}),
      ...(u && (u.backlinks || u.projects) ? { usage: u } : {}) };
    return c ? { ...base, class: c.class, project: c.project, reason: c.reason, ...(c.minutes ? { minutes: c.minutes } : {}) }
      : { ...base, class: 'unclassified', project: null, reason: '분류하지 못함' };
  });
  for (const it of dups) {
    result.push({ id: it.id, title: it.title, url: it.url, source: it.source, date: it.date, ...(it.file ? { file: it.file } : {}), class: 'd', project: null, reason: '같은 링크가 이번 주에 이미 들어와 있는 중복' });
  }
  for (const it of overflow) {
    result.push({ id: it.id, title: it.title, url: it.url, source: it.source, date: it.date, class: 'unclassified', project: null, reason: `주간 상한 ${maxItems}건 초과 — 분류하지 않음` });
  }
  // Time budget only when configured; otherwise c stays c and we just report the total.
  const { usedMinutes, demoted } = budget !== null ? applyBudget(result, budget)
    : { usedMinutes: result.reduce((s, r) => s + (r.class === 'c' ? r.minutes || 0 : 0), 0), demoted: 0 };
  const counts = Object.fromEntries(CLASSES.map((k) => [k, result.filter((r) => r.class === k).length]));
  const ratios = ratioReport(result, targetRatios);
  const out = { week, generatedAt: now.toISOString(), weeklyMinutes: budget, usedMinutes, demoted, counts, ratios, errors, overflow: overflow.length, items: result };
  writeAtticJson(vault, `triage/${week}.json`, out);
  writeAttic(vault, `triage/${week}.md`, renderTriage(out));
  return out;
}

/** Markdown table: actual vs expected ratio. Shown only; nothing is forced to match. */
export function renderRatioTable(r) {
  if (!r || !r.classified) return [];
  const L = ['', `### 실제 비율 vs 기대 비율 (분류된 ${r.classified}건 기준, 참고용 — 억지로 맞추지 않음)`, '', '| 분류 | 건수 | 실제 | 기대 | 차이 |', '|---|---|---|---|---|'];
  for (const k of ['a', 'b', 'c', 'd']) {
    const x = r.rows[k];
    const diff = Math.round((x.actual - x.target) * 100);
    L.push(`| ${k} | ${x.count} | ${pct(x.actual)} | ${pct(x.target)} | ${diff > 0 ? '+' : ''}${diff}%p |`);
  }
  L.push('');
  return L;
}

export function renderTriage(t) {
  const L = [`# Triage ${t.week}`, '', `- 항목 ${t.items.length}개: a ${t.counts.a} / b ${t.counts.b} / c ${t.counts.c} / d ${t.counts.d ?? 0} / 미분류 ${t.counts.unclassified}`,
    t.weeklyMinutes != null ? `- c 예산: ${t.usedMinutes}/${t.weeklyMinutes}분${t.demoted ? `, 예산 초과로 a 로 강등 ${t.demoted}건` : ''}`
      : `- c 예상 시간 합계: ${t.usedMinutes}분 (예산 상한 없음)`];
  if (t.overflow) L.push(`- 주간 상한을 넘어 분류하지 않은 항목 ${t.overflow}건 (config.triage.maxItems 로 조정)`);
  L.push(...renderRatioTable(t.ratios));
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
