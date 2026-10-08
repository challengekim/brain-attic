// 2026-10-08: no caps by default + ratio table, usage signals, 7-day auto-apply, quiz-first teach.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testCtx, tmp, ROOT, fakeLlmEnv } from './helpers.mjs';
import { DEFAULTS } from '../src/config.mjs';
import { triage, normalizeRatios, ratioReport, renderTriage } from '../src/triage.mjs';
import { computeUsage, scanBacklinks, needlesOf, LIMITS } from '../src/usage.mjs';
import { atticPath, ensureSkeleton } from '../src/vault.mjs';
import { createProposal, expireStale, decide, reclassify, getProposal, isApplicable } from '../src/proposals.mjs';
import { apply, WHITELIST } from '../src/apply.mjs';
import { review } from '../src/review.mjs';
import { saveConfig, loadConfig } from '../src/config.mjs';
import { teach } from '../src/teach.mjs';

const NOW = new Date('2026-10-07T12:00:00');
const LOGLLM = path.join(ROOT, 'test', 'fixtures', 'fake-llm-log.mjs');

function inboxCtx(n, triageCfg = { include: [] }, env = fakeLlmEnv('ok')) {
  const ctx = testCtx({ env, config: { triage: triageCfg, llm: { runner: 'claude', model: null, timeoutMs: 20000 } } });
  ensureSkeleton(ctx.vault);
  const L = ['# Inbox', ''];
  for (let i = 1; i <= n; i++) L.push(`### [Item ${i}](https://e.test/${i})`, '- source: Feed', `> summary ${i}`, '');
  fs.writeFileSync(atticPath(ctx.vault, 'inbox', '2026-10-06.md'), L.join('\n'));
  return ctx;
}

// ---------------------------------------------------------------- 1. no caps by default
test('defaults: no maxItems and no weeklyMinutes; targetRatios sum to 1', () => {
  assert.equal(DEFAULTS.triage.maxItems, undefined);
  assert.equal(DEFAULTS.triage.weeklyMinutes, undefined);
  const r = DEFAULTS.triage.targetRatios;
  assert.ok(Math.abs(r.a + r.b + r.c + r.d - 1) < 1e-9);
});

test('no cap by default: 130 items are all classified (several model batches), no demotion', async () => {
  const ctx = inboxCtx(130);
  const t = await triage(ctx, { week: '2026-W41', now: NOW });
  assert.equal(t.items.length, 130);
  assert.equal(t.overflow, 0);
  assert.equal(t.counts.unclassified, 0);
  assert.equal(t.demoted, 0);
  assert.equal(t.weeklyMinutes, null);
  assert.ok(t.counts.c > 0 && t.usedMinutes === t.counts.c * 40);
});

test('explicit maxItems / weeklyMinutes in config are still respected (backward compatible)', async () => {
  const capped = await triage(inboxCtx(30, { include: [], maxItems: 10 }), { week: '2026-W41', now: NOW });
  assert.equal(capped.overflow, 20);
  assert.equal(capped.counts.unclassified, 20);
  const budget = await triage(inboxCtx(30, { include: [], weeklyMinutes: 80 }), { week: '2026-W41', now: NOW });
  assert.equal(budget.weeklyMinutes, 80);
  assert.ok(budget.usedMinutes <= 80 && budget.demoted > 0);
  const zero = await triage(inboxCtx(12, { include: [], weeklyMinutes: 0 }), { week: '2026-W41', now: NOW });
  assert.equal(zero.counts.c, 0); // 0 is a real (strict) budget
});

test('set_triage_budget still works and is still whitelisted', async () => {
  assert.ok(WHITELIST.includes('set_triage_budget'));
  const ctx = testCtx({ config: { sources: [] } });
  saveConfig(ctx.config, ctx.env, ctx.configPath);
  const { proposal } = createProposal(ctx.vault, { kind: 'x', summary: ['b'], payload: { op: 'set_triage_budget', weeklyMinutes: 120 } });
  decide(ctx.vault, proposal.id, 'approved');
  await apply(ctx);
  assert.equal(loadConfig(ctx.env, ctx.configPath).triage.weeklyMinutes, 120);
});

test('ratio table: actual vs expected, shown in the report and the JSON; prompt carries the expectation only', async () => {
  const log = path.join(tmp('rl-'), 'prompts.txt');
  const env = { BRAIN_ATTIC_LLM_CMD: `${process.execPath} ${LOGLLM}`, FAKE_LLM_LOG: log };
  const ctx = inboxCtx(8, { include: [], targetRatios: { a: 0.25, b: 0.25, c: 0.25, d: 0.25 } }, env);
  const t = await triage(ctx, { week: '2026-W41', now: NOW });
  assert.equal(t.ratios.classified, 8);
  assert.equal(t.ratios.rows.a.count, 2);
  assert.equal(t.ratios.rows.a.target, 0.25);
  assert.equal(t.ratios.rows.a.actual, 0.25);
  const md = fs.readFileSync(atticPath(ctx.vault, 'triage', '2026-W41.md'), 'utf8');
  assert.match(md, /실제 비율 vs 기대 비율/);
  assert.match(md, /\| a \| 2 \| 25% \| 25% \| 0%p \|/);
  const prompt = fs.readFileSync(log, 'utf8');
  assert.match(prompt, /기대 비율\(참고만\): a 25% \/ b 25% \/ c 25% \/ d 25%/);
  assert.match(prompt, /억지로 분류하지 않는다/);
  assert.match(renderTriage(t), /기대/);
});

test('ratio table does not force anything: skewed results stay skewed', () => {
  const items = Array.from({ length: 10 }, (_, i) => ({ class: i < 9 ? 'a' : 'd' }));
  const r = ratioReport(items, { a: 0.3, b: 0.45, c: 0.05, d: 0.2 });
  assert.equal(r.rows.a.count, 9);
  assert.equal(r.rows.b.count, 0);
});

test('normalizeRatios: invalid or not summing to 1 -> defaults + warning', () => {
  assert.equal(normalizeRatios(undefined).warning, null);
  assert.equal(normalizeRatios({ a: 0.3, b: 0.45, c: 0.05, d: 0.2 }).warning, null);
  assert.match(normalizeRatios({ a: 0.5, b: 0.5, c: 0.5, d: 0 }).warning, /합이 1/);
  assert.match(normalizeRatios({ a: 0.5 }).warning, /올바르지/);
  assert.equal(normalizeRatios({ a: 'x', b: 0, c: 0, d: 1 }).ratios.b, 0.45);
});

// ---------------------------------------------------------------- 2. usage signals
function usageFixture() {
  const ctx = testCtx({ config: { triage: { include: [] } } });
  const v = ctx.vault;
  fs.mkdirSync(path.join(v, 'Refs'));
  fs.writeFileSync(path.join(v, 'Refs', 'Prompt Caching.md'), 'body');
  fs.writeFileSync(path.join(v, 'Refs', 'Lonely Note.md'), 'body');
  fs.writeFileSync(path.join(v, 'a.md'), 'see [[Prompt Caching]] and [[Refs/Prompt Caching#cost|caching]]');
  fs.writeFileSync(path.join(v, 'b.md'), '[[prompt caching|x]]');
  fs.writeFileSync(path.join(v, 'Refs', 'Prompt Caching.md'), 'self link [[Prompt Caching]]');
  fs.mkdirSync(path.join(v, '_attic', 'inbox'), { recursive: true });
  fs.writeFileSync(path.join(v, '_attic', 'inbox', 'x.md'), '[[Lonely Note]]'); // _attic is ignored
  // two project repos, one mentions by title, one by file name; a third only through a symlink
  const root = tmp('proj-');
  const p1 = path.join(root, 'app'), p2 = path.join(root, 'site'), p3 = path.join(root, 'linked'), outside = path.join(root, 'outside');
  for (const d of [p1, p2, p3, outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(p1, 'README.md'), 'We use Prompt Caching everywhere');
  fs.writeFileSync(path.join(p2, 'notes.txt'), 'see Refs/prompt caching.md');
  fs.writeFileSync(path.join(outside, 'secret.md'), 'Prompt Caching');
  fs.symlinkSync(outside, path.join(p3, 'out')); // symlinked dir must not be followed
  fs.symlinkSync(outside, path.join(root, 'linkroot')); // symlinked project root is skipped too
  fs.mkdirSync(path.join(p1, 'node_modules'));
  fs.writeFileSync(path.join(p1, 'node_modules', 'x.md'), 'Lonely Note');
  ctx.config.triage.projectPaths = [p1, p2, p3, path.join(root, 'linkroot')];
  return { ctx, items: [
    { id: 'i1', title: 'Prompt Caching', file: 'Refs/Prompt Caching.md', url: '' },
    { id: 'i2', title: 'Lonely Note', file: 'Refs/Lonely Note.md', url: '' },
    { id: 'i3', title: 'Prompt Caching', url: 'https://e.test/x', source: 'Feed' },
  ] };
}

test('usage signals: backlinks counted from distinct other notes ([[a|b]], #heading, path, case), _attic and self ignored', () => {
  const { ctx } = usageFixture();
  const m = scanBacklinks(ctx.vault);
  assert.deepEqual([...m.get('prompt caching')].sort(), ['Refs/Prompt Caching.md', 'a.md', 'b.md']); // raw map; computeUsage drops the self link
  assert.equal(m.has('lonely note'), false); // only linked from _attic
});

test('usage signals: projects mentioning the note, symlinks not followed, node_modules skipped', () => {
  const { ctx, items } = usageFixture();
  const u = computeUsage(ctx, items);
  assert.deepEqual([u.get('i1').backlinks, u.get('i1').projects], [2, 2]);
  assert.deepEqual(u.get('i1').projectNames, ['app', 'site']);
  assert.deepEqual([u.get('i2').backlinks, u.get('i2').projects], [0, 0]);
  assert.equal(u.get('i3').backlinks, 0); // feed items have no vault note to link to
  assert.equal(u.get('i3').projects, 2);  // but their title is found in the project texts
});

test('usage signals: two repos with the same folder name count as two projects', () => {
  const ctx = testCtx({ config: { triage: { include: [] } } });
  const root = tmp('same-');
  for (const d of ['a/app', 'b/app']) { fs.mkdirSync(path.join(root, d), { recursive: true }); fs.writeFileSync(path.join(root, d, 'README.md'), 'Prompt Caching'); }
  ctx.config.triage.projectPaths = [path.join(root, 'a/app'), path.join(root, 'b/app')];
  assert.equal(computeUsage(ctx, [{ id: 'i1', title: 'Prompt Caching' }]).get('i1').projects, 2);
});

test('usage signals: project paths also come from the projects file; per-project file cap holds', () => {
  const { ctx, items } = usageFixture();
  const repo = ctx.config.triage.projectPaths[0];
  ctx.config.triage.projectPaths = [];
  fs.mkdirSync(path.join(ctx.vault, '_attic'), { recursive: true });
  const u = computeUsage(ctx, items, { projectLines: [`앱 — 만들기 — ${repo}`, '길 없는 프로젝트 — 설명'] });
  assert.deepEqual(u.get('i1').projectNames, ['앱']);
  // cap: with maxFiles 1 only the first file (sorted) is read
  const big = tmp('cap-'); fs.writeFileSync(path.join(big, 'a.md'), 'nothing'); fs.writeFileSync(path.join(big, 'b.md'), 'Prompt Caching');
  ctx.config.triage.projectPaths = [big];
  const capped = computeUsage(ctx, items, { limits: { ...LIMITS, projectFiles: 1 } });
  assert.equal(capped.get('i1').projects, 0);
  assert.equal(computeUsage(ctx, items).get('i1').projects, 1);
  assert.deepEqual(needlesOf({ title: 'ab', file: 'x/abc.md' }), []); // too short to match safely
});

test('usage signals reach the prompt, with the "two or more projects / often linked -> c candidate" rule', async () => {
  const log = path.join(tmp('ul-'), 'p.txt');
  const { ctx } = usageFixture();
  Object.assign(ctx.env, { BRAIN_ATTIC_LLM_CMD: `${process.execPath} ${LOGLLM}`, FAKE_LLM_LOG: log });
  ctx.config.triage.include = ['Refs'];
  ctx.config.llm = { runner: 'claude', model: null, timeoutMs: 20000 };
  const t = await triage(ctx, { week: '2026-W41', now: new Date() });
  const prompt = fs.readFileSync(log, 'utf8');
  assert.match(prompt, /"usage":\{"backlinks":2,"projects":2\}/);
  assert.match(prompt, /둘 이상의 프로젝트.*c\(내 것으로 만들 것\) 후보/);
  const row = t.items.find((i) => i.file === 'Refs/Prompt Caching.md');
  assert.equal(row.usage.projects, 2);
});

// ---------------------------------------------------------------- 3. 7-day auto-apply
const teachP = (title = 'X') => ({ kind: 'teach', summary: [`깊게 읽고 설명해 볼 것: ${title}`], payload: { op: 'queue_teach', title, url: 'https://e.test/x', kind: 'url', project: null, minutes: 30 } });
const sysP = { kind: 'improve', summary: ['개선 후보'], payload: { op: 'improve_candidate', file: 'x.md' } };
const T0 = new Date('2026-10-01T00:00:00Z');
const DAY8 = new Date('2026-10-09T00:00:00Z');

test('7 days of silence: a classification proposal is auto-approved (autoApplied), a system proposal expires', () => {
  const ctx = testCtx();
  const c = createProposal(ctx.vault, teachP(), T0).proposal;
  const b = createProposal(ctx.vault, { kind: 'auto', summary: ['b'], payload: { op: 'note_auto', title: 'T', kind: 'topic' } }, T0).proposal;
  const d = createProposal(ctx.vault, { kind: 'drop', summary: ['d'], payload: { op: 'archive_note', title: 'T', file: 'n.md', kind: 'vault' } }, T0).proposal;
  const s = createProposal(ctx.vault, sysP, T0).proposal;
  const sr = createProposal(ctx.vault, { kind: 'system', summary: ['sr'], payload: { op: 'system_review' } }, T0).proposal;
  const src = createProposal(ctx.vault, { kind: 'x', summary: ['src'], payload: { op: 'add_source', source: { type: 'rss', url: 'https://x.test/f' } } }, T0).proposal;
  assert.equal(expireStale(ctx.vault, new Date('2026-10-07T23:00:00Z')).length, 0); // day 6: nothing yet
  expireStale(ctx.vault, DAY8);
  for (const p of [c, b, d]) {
    const g = getProposal(ctx.vault, p.id);
    assert.equal(g.status, 'approved');
    assert.equal(g.autoApplied, true);
    assert.equal(g.decidedBy, 'auto');
    assert.equal(isApplicable(g), true);
  }
  for (const p of [s, sr, src]) assert.equal(getProposal(ctx.vault, p.id).status, 'expired'); // systems stay safe
});

test('attic apply performs the auto-approved proposal and records auto: true', async () => {
  const ctx = testCtx();
  const c = createProposal(ctx.vault, teachP(), T0).proposal;
  expireStale(ctx.vault, DAY8);
  const r = await apply(ctx, { now: DAY8 });
  assert.deepEqual(r.applied.map((x) => [x.id, x.auto]), [[c.id, true]]);
  const g = getProposal(ctx.vault, c.id);
  assert.equal(g.status, 'applied');
  assert.equal(g.autoApplied, true);
  assert.equal(JSON.parse(fs.readFileSync(atticPath(ctx.vault, 'teach', 'queue.json'), 'utf8'))[0].proposalId, c.id);
});

test('user instruction beats the auto rule: reject stays rejected, reclassify changes the class, "apply now" is immediate', async () => {
  const ctx = testCtx({ config: { sources: [] } });
  const rej = createProposal(ctx.vault, teachP('R'), T0).proposal;
  const re = createProposal(ctx.vault, teachP('C'), T0).proposal;
  const toA = createProposal(ctx.vault, teachP('A'), T0).proposal;
  const now = createProposal(ctx.vault, teachP('N'), T0).proposal;
  decide(ctx.vault, rej.id, 'rejected', { now: new Date('2026-10-02T00:00:00Z') });
  const rc = reclassify(ctx.vault, re.id, 'b', { now: new Date('2026-10-02T00:00:00Z') });
  assert.equal(rc.payload.op, 'note_auto');
  assert.equal(rc.recommended.class, 'c');
  assert.equal(rc.generation, 2); assert.deepEqual(rc.external, {}); // old remote card/answers no longer match
  assert.throws(() => reclassify(ctx.vault, re.id, 'd', { now: new Date('2026-10-02T00:00:00Z') }), /보관|볼트 노트/);
  assert.equal(reclassify(ctx.vault, toA.id, 'a', { now: new Date('2026-10-02T00:00:00Z') }).status, 'rejected');
  const imm = decide(ctx.vault, now.id, 'approved', { now: new Date('2026-10-02T00:00:00Z') });
  assert.equal(imm.proposal.autoApplied, undefined); // an answer inside the TTL is a normal approval
  expireStale(ctx.vault, DAY8);
  assert.equal(getProposal(ctx.vault, rej.id).status, 'rejected');
  assert.equal(getProposal(ctx.vault, toA.id).status, 'rejected');
  const g = getProposal(ctx.vault, re.id);
  assert.equal(g.status, 'approved'); assert.equal(g.payload.op, 'note_auto'); // auto-applied AS the user's class
  // a late "reject" is an explicit instruction too
  const late = createProposal(ctx.vault, teachP('L'), T0).proposal;
  assert.equal(decide(ctx.vault, late.id, 'rejected', { now: DAY8 }).proposal.status, 'rejected');
  // a late "approve" on a system proposal is still refused
  const sys = createProposal(ctx.vault, sysP, T0).proposal;
  assert.equal(decide(ctx.vault, sys.id, 'approved', { now: DAY8 }).reason, 'expired');
});

test('review() 8 days later: auto-applies silent classification proposals, expires system ones, says so in the sheet', async () => {
  const ctx = testCtx({ env: fakeLlmEnv('ok'), config: { triage: { include: [] }, llm: { runner: 'claude', model: null, timeoutMs: 20000 }, notifiers: [] } });
  ensureSkeleton(ctx.vault);
  const c = createProposal(ctx.vault, teachP('Q'), T0).proposal;
  const s = createProposal(ctx.vault, sysP, T0).proposal;
  const r = await review(ctx, { now: DAY8, week: '2026-W41' });
  assert.deepEqual(r.autoApplied, [c.id]);
  assert.equal(r.expired, 1);
  assert.equal(getProposal(ctx.vault, c.id).status, 'applied');
  assert.equal(getProposal(ctx.vault, s.id).status, 'expired');
  assert.match(fs.readFileSync(r.sheetFile, 'utf8'), /7일 무응답으로 추천 분류가 자동 적용된 제안/);
  assert.deepEqual(r.autoErrors, []);
  // dry-run neither approves nor applies: the proposal stays pending, so reject / reclassify still work
  const c2 = createProposal(ctx.vault, teachP('Q2'), T0).proposal;
  const dry = await review(ctx, { now: DAY8, week: '2026-W41', dryRun: true });
  assert.equal(getProposal(ctx.vault, c2.id).status, 'pending');
  assert.deepEqual(dry.autoApplied, []);
  // a second real run reports each auto-applied proposal once
  const again = await review(ctx, { now: DAY8, week: '2026-W41' });
  assert.deepEqual(again.autoApplied, [c2.id]);
  assert.deepEqual((await review(ctx, { now: DAY8, week: '2026-W41' })).autoApplied, []);
});

// ---------------------------------------------------------------- 4. quiz-first teach
test('teach --quiz-first: questions come before the explanation; session is saved with mode quiz-first', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-qf-'));
  const printed = [], asks = ['', 'b', 'b', 'same prefix, cheaper, answer unchanged'];
  const io = { print: (s = '') => printed.push(s), ask: async () => asks.shift() ?? '', askMulti: async () => asks.shift() ?? '' };
  const FAKE = path.join(ROOT, 'test', 'fixtures', 'fake-teach-llm.mjs');
  const logFile = path.join(vault, 'prompts.log');
  const ctx = { env: { ...process.env, HOME: vault, BRAIN_ATTIC_LLM_CMD: `${process.execPath} ${FAKE}`, FAKE_TEACH_LOG: logFile }, home: vault, vault, io,
    config: { llm: { runner: 'claude', timeoutMs: 20000 }, teach: {} }, log: { info() {}, warn() {} }, fetch: async () => { throw new Error('no network'); } };
  assert.equal(await teach(['--quiz-first', 'prompt caching'], ctx), 0);
  const text = printed.join('\n');
  assert.ok(text.indexOf('문제 먼저') >= 0 && text.indexOf('문제 먼저') < text.indexOf('Prompt caching stores the prompt prefix'), 'explanation only after the questions');
  assert.ok(text.indexOf('Prefix changes. What happens?') < text.indexOf('Prompt caching stores the prompt prefix'));
  assert.ok(text.indexOf('Prompt caching stores the prompt prefix') < text.indexOf('이제 직접 설명해 보세요'));
  const pack = JSON.parse(fs.readFileSync(path.join(vault, '_attic', 'teach', 'prompt-caching.pack.json'), 'utf8'));
  assert.equal(pack.sessions[0].mode, 'quiz-first');
  assert.match(fs.readFileSync(logFile, 'utf8'), /문제 먼저 모드/); // pack prompt asks for open-book questions
});
