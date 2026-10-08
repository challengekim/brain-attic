import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCtx, tmp, startServer } from './helpers.mjs';
import { atticPath, ensureSkeleton } from '../src/vault.mjs';
import { isoWeek } from '../src/util.mjs';
import { createProposal, decide, expireStale, getProposal, listProposals, saveProposal } from '../src/proposals.mjs';
import { gatherItems, normalizeItem, normalizeProject, projectName, relevanceOf, TRIAGE_SCHEMA, triageInputKey } from '../src/triage.mjs';
import { buildDescriptors, MAX_TRY, renderSheet, review } from '../src/review.mjs';
import { apply } from '../src/apply.mjs';
import { applyTry, EX_TEMPFAIL, renderTodoArgv, resolveTodo, todoConfig, todoStatus } from '../src/todo.mjs';
import * as api from '../src/notify/decision-api.mjs';

const NOW = new Date('2026-10-08T08:30:00Z');
const PROJECTS = ['casebook — 브라우저 추리 게임 — 마케팅', 'life-command-center — 개인 지휘본부 — 할일'];
const aud = { scannedFiles: 0, models: {}, tools: {}, suggestions: [] };

/** A to-do command that appends its argv to a log file and exits with $FAKE_TODO_EXIT (default 0). */
function fakeTodo() {
  const dir = tmp('attic-todo-');
  const log = path.join(dir, 'calls.jsonl');
  const bin = path.join(dir, 'fake-todo');
  fs.writeFileSync(bin, `#!${process.execPath}\nconst fs = require('fs');\nconst ms = Number(process.env.FAKE_TODO_SLEEP || 0);\nconst end = Date.now() + ms; while (Date.now() < end) {}\nfs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nprocess.exit(Number(process.env.FAKE_TODO_EXIT || 0));\n`);
  fs.chmodSync(bin, 0o755);
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { bin, calls };
}
const tryItem = (title, extra = {}) => ({ id: title, title, url: `https://e.test/${encodeURIComponent(title)}`, source: 'Feed', class: 'c', action: 'try', project: 'casebook', next: `${title} 을 casebook 세션에만 붙여 본다`, check: '탐색 토큰 전/후 비교', reason: 'r', minutes: 30, ...extra });
const tryProposal = (ctx, title = 'T', now = NOW) => {
  const [d] = buildDescriptors({ items: [tryItem(title)] }, aud);
  return createProposal(ctx.vault, { ...d, source: 'review' }, now).proposal;
};
const approved = (ctx, title = 'T') => { const p = tryProposal(ctx, title); decide(ctx.vault, p.id, 'approved', { now: NOW }); return p; };

// ---------------------------------------------------------------- triage input and output

test('projectName / normalizeProject: the model may answer the name or the full line; anything else -> null', () => {
  assert.equal(projectName(PROJECTS[1]), 'life-command-center', 'hyphens inside a name are not separators');
  assert.equal(normalizeProject('casebook', PROJECTS), 'casebook');
  assert.equal(normalizeProject('CaseBook', PROJECTS), 'casebook');
  assert.equal(normalizeProject(PROJECTS[0], PROJECTS), 'casebook');
  assert.equal(normalizeProject('case', PROJECTS), null);
  assert.equal(normalizeProject(null, PROJECTS), null);
});

test('gatherItems: description is the summary, my_relevance/applicable_when go to relevance, triage.exclude skips folders', () => {
  const ctx = testCtx({ config: { triage: { include: ['Refs'], exclude: ['Refs/Worklog/'] } } });
  ensureSkeleton(ctx.vault);
  fs.mkdirSync(path.join(ctx.vault, 'Refs', 'Worklog'), { recursive: true });
  fs.writeFileSync(path.join(ctx.vault, 'Refs', 'tools.md'), '---\ntitle: 도구 4가지\nsource: https://e.test/reel\ndescription: 코딩 에이전트 도구 네 개\nmy_relevance: "Codebase Memory MCP 가 탐색 비용과 닿는다"\napplicable_when: "탐색 토큰이 많을 때"\n---\n> 원문: 릴스\n');
  fs.writeFileSync(path.join(ctx.vault, 'Refs', 'Worklog', 'log.md'), '---\ntitle: 워크로그\n---\n자동 생성\n');
  const items = gatherItems(ctx, isoWeek(new Date()), new Date());
  assert.equal(items.length, 1, 'worklog folder is excluded');
  assert.equal(items[0].summary, '코딩 에이전트 도구 네 개');
  assert.equal(items[0].url, 'https://e.test/reel', 'source: URL is the link');
  assert.match(items[0].relevance, /Codebase Memory MCP/);
  assert.match(items[0].relevance, /적용 시점: 탐색 토큰이 많을 때/);
  assert.equal(relevanceOf({}), '');
});

test('normalizeItem: try needs a project, next and check; otherwise it is learn (nothing is filled in)', () => {
  const ok = normalizeItem({ id: 'i1', class: 'c', minutes: 20, action: 'try', project: 'casebook', next: '세션 한정으로 붙인다', check: '토큰 비교', reason: 'r' }, PROJECTS);
  assert.deepEqual([ok.action, ok.project, ok.next, ok.check], ['try', 'casebook', '세션 한정으로 붙인다', '토큰 비교']);
  for (const miss of [{ project: null }, { next: '' }, { check: '   ' }, { project: 'nope' }]) {
    const n = normalizeItem({ id: 'i1', class: 'c', minutes: 20, action: 'try', project: 'casebook', next: 'n', check: 'c', reason: 'r', ...miss }, PROJECTS);
    assert.equal(n.action, 'learn', JSON.stringify(miss));
    assert.equal(n.next, undefined);
  }
  assert.equal(normalizeItem({ id: 'i1', class: 'c', minutes: 20, reason: 'r' }, PROJECTS).action, 'learn');
  assert.equal(normalizeItem({ id: 'i1', class: 'a', reason: 'r', action: 'try' }, PROJECTS).action, undefined);
});

// ---------------------------------------------------------------- proposals

test('buildDescriptors: try -> try_in_project card with next/check; learn -> queue_teach; caps count only items without a card', () => {
  const items = [...Array.from({ length: MAX_TRY + 2 }, (_, n) => tryItem(`T${n}`)), { ...tryItem('L'), action: 'learn' }];
  const ds = buildDescriptors({ items }, aud);
  const tries = ds.filter((d) => d.payload.op === 'try_in_project');
  assert.equal(tries.length, MAX_TRY);
  assert.match(tries[0].summary[0], /해 볼 것 \(casebook\): T0/);
  assert.match(tries[0].summary[1], /다음 행동: T0 을 casebook/);
  assert.match(tries[0].summary[2], /판정: 탐색 토큰/);
  assert.equal(ds.filter((d) => d.payload.op === 'queue_teach').length, 1);
  // At the cap: an item that already has a pending card is re-emitted without taking a slot,
  // so a newly switched item still gets one (Codex plan review, round 2).
  const represented = new Map([['try_in_project\u0000https://e.test/T0', 'pending'], ['try_in_project\u0000https://e.test/T1', 'done']]);
  const again = buildDescriptors({ items: [tryItem('T0'), tryItem('T1'), tryItem('NEW')] }, aud, { try_in_project: MAX_TRY - 1 }, [], represented);
  assert.deepEqual(again.map((d) => d.payload.title), ['T0', 'NEW'], 'T1 already answered -> no card; NEW gets the last slot');
});

test('review re-run: a learn card whose item became try is withdrawn and a try card is made (even at the teach cap)', async () => {
  const ctx = testCtx({ config: { triage: { include: [] }, notifiers: [], audit: { paths: [] } } });
  ensureSkeleton(ctx.vault);
  const week = isoWeek(NOW);
  const first = new Date(NOW.getTime() - 7 * 60000);
  const learn = createProposal(ctx.vault, { kind: 'teach', summary: ['깊게 읽고 설명해 볼 것: X', '이유: r'], payload: { op: 'queue_teach', title: 'X', url: 'https://e.test/X', kind: 'url', project: null, minutes: 30 }, source: 'review' }, first).proposal;
  const tri = { schema: TRIAGE_SCHEMA, inputKey: triageInputKey(ctx), week, generatedAt: new Date(Date.now() + 3600000).toISOString(), weeklyMinutes: null, usedMinutes: 30, demoted: 0, errors: [], counts: { a: 0, b: 0, c: 1, d: 0, unclassified: 0 }, items: [tryItem('X')] };
  fs.writeFileSync(atticPath(ctx.vault, 'triage', `${week}.json`), JSON.stringify(tri));
  const r = await review(ctx, { now: NOW });
  assert.equal(getProposal(ctx.vault, learn.id).status, 'withdrawn');
  assert.match(getProposal(ctx.vault, learn.id).withdrawReason, /해 볼 것/);
  const made = r.proposals.map((id) => getProposal(ctx.vault, id));
  assert.equal(made.length, 1);
  assert.equal(made[0].payload.op, 'try_in_project');
  const sheet = fs.readFileSync(r.sheetFile, 'utf8');
  assert.match(sheet, /## 이번 주 해 볼 것\n\n1\. \[X\]\(https:\/\/e\.test\/X\) — \*\*casebook\*\*/);
  assert.match(sheet, /- 다음: X 을 casebook 세션에만 붙여 본다/);
  // a re-run of the same week does not make a second card
  const again = await review(ctx, { now: NOW });
  assert.deepEqual(again.proposals, r.proposals);
  assert.equal(listProposals(ctx.vault).filter((p) => p.payload.op === 'try_in_project').length, 1);
});

test('renderSheet lists saved notes judged a/d under «들이지 않기로 한 것» with the reason', () => {
  const tri = { week: 'W', counts: { a: 1, b: 0, c: 0, d: 0, unclassified: 0 }, usedMinutes: 0, weeklyMinutes: null, errors: [], items: [
    { id: 'i1', title: 'Agency Agents', file: 'Refs/a.md', class: 'a', reason: '이미 자체 에이전트 체계가 있어 들일 이유가 약함', relevance: '가치가 낮다' },
  ] };
  const sheet = renderSheet({ vault: '/v', week: 'W', tri, aud, events: [], descriptors: [], dryRun: true, nowIso: 'now' });
  assert.match(sheet, /들이지 않기로 한 것/);
  assert.match(sheet, /\[\[Refs\/a\|Agency Agents\]\] — 인지만: 이미 자체 에이전트 체계가/);
});

test('try proposals are not auto-applied: silence expires them', () => {
  const ctx = testCtx(); ensureSkeleton(ctx.vault);
  const p = tryProposal(ctx);
  expireStale(ctx.vault, new Date(NOW.getTime() + 8 * 86400000));
  assert.equal(getProposal(ctx.vault, p.id).status, 'expired');
});

// ---------------------------------------------------------------- apply -> task

test('apply without config.todo: instruction file only, the proposal stays approved (a hook set later still delivers)', async () => {
  const ctx = testCtx(); ensureSkeleton(ctx.vault);
  const p = approved(ctx);
  const r = await apply(ctx, { now: NOW });
  assert.equal(r.prompts.length, 1);
  const prompt = fs.readFileSync(atticPath(ctx.vault, 'approved', `${p.id}.prompt.md`), 'utf8');
  assert.match(prompt, /해 볼 것 — T \(casebook\)/);
  assert.match(prompt, /판정: 탐색 토큰 전\/후 비교/);
  assert.match(prompt, /전역 설정 변경이나 상시 등록은 하지 않습니다/);
  assert.equal(getProposal(ctx.vault, p.id).status, 'approved');
  const f = fakeTodo();
  ctx.config.todo = { argv: [f.bin, '{title}'] };
  await apply(ctx, { now: NOW });
  assert.equal(f.calls().length, 1);
  assert.equal(getProposal(ctx.vault, p.id).status, 'applied');
});

test('apply with config.todo: one task, filled argv, applied; a later apply does not run it again', async () => {
  const f = fakeTodo();
  const ctx = testCtx({ config: { todo: { argv: [f.bin, '{title}', '--due', '{due}', '--body', '{body}', '--tags', '{tags}'], dueDays: 3 } } });
  ensureSkeleton(ctx.vault);
  const p = approved(ctx);
  const r = await apply(ctx, { now: NOW });
  assert.deepEqual(r.applied.map((x) => x.id), [p.id]);
  const [argv] = f.calls();
  assert.equal(argv[0], '[attic] casebook: T');
  assert.equal(argv[2], '2026-10-11', 'approval date + 3 days');
  assert.match(argv[4], /다음 행동: T 을 casebook/);
  assert.match(argv[4], new RegExp(`attic:${p.id}`));
  assert.equal(argv[6], 'attic,casebook');
  const q = getProposal(ctx.vault, p.id);
  assert.equal(q.status, 'applied');
  assert.equal(q.todo.state, 'delivered');
  await apply(ctx, { now: NOW });
  assert.equal(f.calls().length, 1);
});

test('two applies at the same time deliver once (lock taken before any write)', async () => {
  const f = fakeTodo();
  const ctx = testCtx({ config: { todo: { argv: [f.bin, '{title}'] } }, env: { FAKE_TODO_SLEEP: '300' } });
  ensureSkeleton(ctx.vault);
  const p = approved(ctx);
  const [a, b] = await Promise.all([applyTry(ctx, ctx.vault, p.id, NOW), applyTry(ctx, ctx.vault, p.id, NOW)]);
  assert.equal(f.calls().length, 1);
  assert.equal([a, b].filter((x) => x.applied).length, 1);
  assert.equal([a, b].filter((x) => x.skipped).length, 1);
  assert.equal(getProposal(ctx.vault, p.id).todo.state, 'delivered');
});

test(`exit ${EX_TEMPFAIL} = not created -> retried next time; other exit = unknown -> never retried until a human resolves`, async () => {
  const f = fakeTodo();
  const ctx = testCtx({ config: { todo: { argv: [f.bin, '{title}'] } }, env: { FAKE_TODO_EXIT: String(EX_TEMPFAIL) } });
  ensureSkeleton(ctx.vault);
  const p = approved(ctx);
  let r = await apply(ctx, { now: NOW });
  assert.equal(r.errors.length, 1);
  assert.equal(getProposal(ctx.vault, p.id).todo, undefined);
  ctx.env.FAKE_TODO_EXIT = '1';
  r = await apply(ctx, { now: NOW });
  assert.equal(f.calls().length, 2, 'retried after the temp failure');
  assert.ok(r.errors[0].uncertain);
  assert.equal(getProposal(ctx.vault, p.id).todo.state, 'uncertain');
  ctx.env.FAKE_TODO_EXIT = '0';
  r = await apply(ctx, { now: NOW });
  assert.equal(f.calls().length, 2, 'unknown result: not retried by itself');
  assert.equal(r.skipped.length, 1);
  assert.deepEqual(todoStatus(ctx.vault).map((t) => [t.id, t.state]), [[p.id, 'uncertain']]);
  resolveTodo(ctx.vault, p.id, 'retry');
  await apply(ctx, { now: NOW });
  assert.equal(f.calls().length, 3);
  assert.equal(getProposal(ctx.vault, p.id).status, 'applied');
  assert.deepEqual(todoStatus(ctx.vault), []);
});

test('resolve --delivered closes an unknown delivery without running the command; a missing command is retried', async () => {
  const ctx = testCtx({ config: { todo: { argv: ['/nonexistent/todo-cli', '{title}'] } } });
  ensureSkeleton(ctx.vault);
  const p = approved(ctx);
  const r = await apply(ctx, { now: NOW });
  assert.match(r.errors[0].error, /찾지 못했습니다/);
  assert.equal(getProposal(ctx.vault, p.id).status, 'approved');
  assert.deepEqual(todoStatus(ctx.vault), [], 'nothing ran, nothing to resolve');
  const q = getProposal(ctx.vault, p.id); q.todo = { state: 'uncertain', at: 'x' }; saveProposal(ctx.vault, q);
  resolveTodo(ctx.vault, p.id, 'delivered');
  assert.equal(getProposal(ctx.vault, p.id).status, 'applied');
});

test('renderTodoArgv: a value starting with "-" cannot become an option; due never in the past; config validation', () => {
  const p = { id: 'attic-000000000000', decidedAt: '2026-09-01T00:00:00Z', payload: { title: '--evil', project: 'casebook', next: 'n', check: 'c' } };
  const argv = renderTodoArgv({ argv: ['cmd', '{title}', '{project}-x', '--due', '{due}'], dueDays: 3 }, { ...p, payload: { ...p.payload } }, { now: NOW });
  assert.equal(argv[1], '[attic] casebook: --evil');
  const evil = renderTodoArgv({ argv: ['cmd', '{url}{title}'], dueDays: 3 }, { ...p, payload: { ...p.payload, url: '' } }, { now: NOW });
  assert.equal(evil[1], '[attic] casebook: --evil', 'starts with "[" -> unchanged');
  const dash = renderTodoArgv({ argv: ['cmd', '{project}'], dueDays: 3 }, { ...p, payload: { ...p.payload, project: '-rf' } }, { now: NOW });
  assert.equal(dash[1], '·-rf');
  assert.equal(argv[4], '2026-10-08', 'decided long ago -> today, not a past date');
  assert.equal(todoConfig({ config: { todo: { argv: [] } } }), null);
  assert.equal(todoConfig({ config: { todo: { argv: ['x', 3] } } }), null);
  assert.equal(todoConfig({ config: { todo: { argv: ['x'], dueDays: 'a' } } }).dueDays, 3);
});

// ---------------------------------------------------------------- answers from the app

function mockApi(answers) {
  return startServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.method === 'GET' ? { data: { answers } } : { ok: true })); });
}
const cfgFor = (s) => ({ type: 'decision-api', baseUrl: s.url, tokenEnv: 'ATTIC_TEST_TOKEN', kind: 'knowledge' });

test('decision-api: an approval given before the deadline counts even when pulled after it (pending or already expired)', async () => {
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' } }); ensureSkeleton(ctx.vault);
  const created = new Date(Date.now() - 9 * 86400000); // deadline was 2 days ago
  const answeredAt = new Date(created.getTime() + 2 * 86400000).toISOString();
  const mk = (title) => { const p = tryProposal(ctx, title, created); p.external = { 'decision-api': { sentAt: created.toISOString(), changeId: p.id } }; return saveProposal(ctx.vault, p); };
  const stillPending = mk('P');
  const expired = mk('E');
  expireStale(ctx.vault, new Date(), { auto: false }); // e.g. `attic pending` expired both locally
  const late = mk('LATE'); // answered after its deadline -> stays expired
  const s = await mockApi([
    { changeId: stillPending.id, kind: 'knowledge', approved: true, answeredAt },
    { changeId: expired.id, kind: 'knowledge', approved: true, answeredAt },
    { changeId: late.id, kind: 'knowledge', approved: true, answeredAt: new Date(Date.now() - 3600000).toISOString() },
  ]);
  const r = await api.pull(ctx, cfgFor(s));
  await s.close();
  assert.equal(getProposal(ctx.vault, stillPending.id).status, 'approved');
  assert.equal(getProposal(ctx.vault, expired.id).status, 'approved');
  assert.equal(getProposal(ctx.vault, expired.id).decidedAt, answeredAt);
  assert.equal(getProposal(ctx.vault, late.id).status, 'expired');
  assert.equal(r.acked.length, 3);
});

test('review with a failed sync expires nothing (an on-time answer may be waiting in the app)', async () => {
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' }, config: { triage: { include: [] }, audit: { paths: [] }, notifiers: [{ type: 'decision-api', baseUrl: 'http://127.0.0.1:9', tokenEnv: 'ATTIC_TEST_TOKEN', kind: 'knowledge' }] } });
  ensureSkeleton(ctx.vault);
  const old = new Date(Date.now() - 9 * 86400000);
  const p = tryProposal(ctx, 'OLD', old);
  const week = isoWeek(new Date());
  fs.writeFileSync(atticPath(ctx.vault, 'triage', `${week}.json`), JSON.stringify({ schema: TRIAGE_SCHEMA, inputKey: triageInputKey(ctx), week, generatedAt: new Date(Date.now() + 3600000).toISOString(), errors: [], counts: { a: 0, b: 0, c: 0, d: 0, unclassified: 0 }, items: [{ id: 'z', title: 'z', url: 'https://e.test/z', class: 'a', reason: 'r' }] }));
  await review(ctx, {});
  assert.equal(getProposal(ctx.vault, p.id).status, 'pending');
});

test('try ranking: priority first, then notes saved with a judgement, then usage, then shorter; the cap keeps the top', () => {
  const items = [
    tryItem('LOW', { priority: 3, minutes: 5 }),
    tryItem('SAVED', { priority: 2, relevance: '내 판단' }),
    tryItem('MID', { priority: 2 }),
    tryItem('TOP', { priority: 1, minutes: 90 }),
    ...Array.from({ length: MAX_TRY }, (_, n) => tryItem(`FILL${n}`, { priority: 3 })),
  ];
  const picked = buildDescriptors({ items }, aud).filter((d) => d.payload.op === 'try_in_project').map((d) => d.payload.title);
  assert.deepEqual(picked.slice(0, 3), ['TOP', 'SAVED', 'MID']);
  assert.equal(picked.length, MAX_TRY);
  assert.equal(normalizeItem({ id: 'i', class: 'c', minutes: 5, action: 'try', project: 'casebook', next: 'n', check: 'c', reason: 'r', priority: 9 }, PROJECTS).priority, 3, 'invalid -> lowest');
  const sheet = renderSheet({ vault: '/v', week: 'W', tri: { counts: { a: 0, b: 0, c: items.length, d: 0, unclassified: 0 }, usedMinutes: 0, weeklyMinutes: null, errors: [], items }, aud, events: [], descriptors: [], dryRun: true, nowIso: 'now' });
  assert.match(sheet, /1\. \[TOP\]/);
  assert.match(sheet, /가장 먼저/);
  assert.match(sheet, /그 밖의 후보 4건/);
});
