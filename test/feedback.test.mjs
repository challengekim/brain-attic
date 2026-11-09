// Feedback loop (2026-11-09): the owner's answers (approve / reject / change class) become a ledger, the ledger and the
// rules the owner approved go into the next classification prompt, the review proposes new rules as cards, and the
// weekly agreement rate is reported. Also: b/d and "new models" cards are off unless turned on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCtx, fakeLlmEnv } from './helpers.mjs';
import { atticPath, ensureSkeleton } from '../src/vault.mjs';
import { createProposal, decide, reclassify, saveProposal, getProposal, withdraw } from '../src/proposals.mjs';
import { decisionOf, buildLedger, weeklyMetrics, guideFor, readRules, recordReason, ruleDescriptors, uncoveredDisagreements, renderMetrics } from '../src/feedback.mjs';
import { buildPrompt, triageInputKey } from '../src/triage.mjs';
import { buildDescriptors } from '../src/review.mjs';
import { apply } from '../src/apply.mjs';
import { compute, renderRetro } from '../src/retro.mjs';

const T0 = new Date('2026-11-04T12:00:00+09:00'); // 2026-W45 (Wednesday)
const LATER = new Date('2026-11-09T18:00:00+09:00');

function ctxWithVault(extra = {}) {
  const ctx = testCtx({ env: fakeLlmEnv('ok'), ...extra });
  ensureSkeleton(ctx.vault);
  return ctx;
}
const teach = (title, extra = {}) => ({ kind: 'teach', summary: [`깊게 읽고 설명해 볼 것: ${title}`], payload: { op: 'queue_teach', title, url: `https://x.test/${encodeURIComponent(title)}`, kind: 'url', project: null, minutes: 60, ...extra } });
const auto = (title) => ({ kind: 'auto', summary: [`자동 적용 후보 — ${title}`], payload: { op: 'note_auto', title, url: `https://x.test/${encodeURIComponent(title)}`, kind: 'url', project: null } });
const tryP = (title) => ({ kind: 'try', summary: [`해 볼 것 (app): ${title}`], payload: { op: 'try_in_project', title, url: '', kind: 'topic', project: 'app', pain: 'p', next: 'n', check: 'c', reason: 'r', minutes: 30 } });
const sys = () => ({ kind: 'system', summary: ['새 모델 27종이 나왔다'], payload: { op: 'system_review', newModels: ['m1'], modelsInUse: [], scannedFiles: 0, prompt: 'x' } });

function seed(vault) {
  const mk = (d) => createProposal(vault, { ...d, source: 'review' }, T0).proposal;
  const ok = mk(teach('agreed one'));
  decide(vault, ok.id, 'approved', { by: 'decision-api', now: LATER });
  const ca = mk(teach('c to a'));
  reclassify(vault, ca.id, 'a', { by: 'decision-api', now: LATER });
  const ba = mk(auto('b to a'));
  reclassify(vault, ba.id, 'a', { by: 'decision-api', now: LATER });
  const rej = mk(tryP('rejected try'));
  decide(vault, rej.id, 'rejected', { by: 'decision-api', now: LATER });
  const sr = mk(sys());
  decide(vault, sr.id, 'rejected', { by: 'decision-api', now: LATER });
  const silent = mk(teach('silent auto'));
  saveProposal(vault, { ...getProposal(vault, silent.id), status: 'applied', decidedBy: 'auto', autoApplied: true, decidedAt: LATER.toISOString() });
  const pend = mk(teach('still pending'));
  const wd = mk(teach('withdrawn one'));
  withdraw(vault, wd.id, { by: 'cli', now: LATER });
  return { ok, ca, ba, rej, sr, silent, pend, wd };
}

test('decisionOf: only human answers count; recommended vs final class, agreement', () => {
  const ctx = ctxWithVault();
  const s = seed(ctx.vault);
  const d = (p) => decisionOf(getProposal(ctx.vault, p.id));
  assert.deepEqual([d(s.ok).recommended, d(s.ok).final, d(s.ok).agreed], ['c', 'c', true]);
  assert.deepEqual([d(s.ca).recommended, d(s.ca).final, d(s.ca).agreed], ['c', 'a', false]);
  assert.deepEqual([d(s.ba).recommended, d(s.ba).final, d(s.ba).agreed], ['b', 'a', false]);
  assert.deepEqual([d(s.rej).recommended, d(s.rej).final, d(s.rej).agreed], ['c(try)', 'rejected', false]);
  assert.deepEqual([d(s.sr).recommended, d(s.sr).final, d(s.sr).agreed], ['system', 'rejected', false]);
  // silence (auto), pending, withdrawn: nobody answered -> not in the ledger
  assert.equal(d(s.silent), null);
  assert.equal(d(s.pend), null);
  assert.equal(d(s.wd), null);
});

test('buildLedger: entries carry the reason the owner gave (tag + note), written under _attic/feedback', () => {
  const ctx = ctxWithVault();
  const s = seed(ctx.vault);
  recordReason(ctx.vault, s.ba.id, 'already-in-system', '이미 CLAUDE.md 에 있는 규칙', { now: LATER });
  assert.throws(() => recordReason(ctx.vault, s.ba.id, 'no-such-tag', ''), /이유 태그/);
  const led = buildLedger(ctx.vault, { now: LATER });
  assert.equal(led.entries.length, 5);
  const ba = led.entries.find((e) => e.id === s.ba.id);
  assert.equal(ba.reasonTag, 'already-in-system');
  assert.equal(ba.note, '이미 CLAUDE.md 에 있는 규칙');
  assert.equal(ba.week, '2026-W45');
  assert.ok(fs.existsSync(atticPath(ctx.vault, 'feedback', 'ledger.json')));
});

test('weeklyMetrics: agreement rate per week and b/d execution rate', () => {
  const ctx = ctxWithVault();
  seed(ctx.vault);
  const led = buildLedger(ctx.vault, { now: LATER });
  const m = weeklyMetrics(led.entries, ctx.vault);
  const w = m.find((x) => x.week === '2026-W45');
  assert.equal(w.answered, 5);
  assert.equal(w.agreed, 1);
  assert.equal(w.rate, 0.2);
  // b/d: one note_auto answered (b -> a, not approved as b) -> 0 approved as b/d, so execution is n/a
  assert.equal(w.bd.approved, 0);
  assert.match(renderMetrics(m).join('\n'), /2026-W45 \| 5 \| 1 \| 20%/);
});

test('guide: approved rules, recent answers (disagreements first) and system context reach the triage prompt', () => {
  const home = testCtx().home;
  const claudeMd = path.join(home, 'CLAUDE.md');
  fs.writeFileSync(claudeMd, '# rules\n- 에러는 단서로 본다 SENTINEL-RULE\n');
  const skills = path.join(home, 'skills');
  fs.mkdirSync(path.join(skills, 'decision-triage'), { recursive: true });
  fs.writeFileSync(path.join(skills, 'decision-triage', 'SKILL.md'), '---\nname: decision-triage\ndescription: 결정필요 정리 SENTINEL-SKILL\n---\nbody');
  const ctx = ctxWithVault({ config: { triage: { context: [claudeMd], skillsDirs: [skills] } } });
  const s = seed(ctx.vault);
  recordReason(ctx.vault, s.ca.id, 'already-implemented', '상시 창구로 이미 구현', { now: LATER });
  fs.writeFileSync(atticPath(ctx.vault, 'rules', 'triage-rules.json'), JSON.stringify({ rules: [{ id: 'r1', text: '자동 다이제스트는 원문을 본다 SENTINEL-APPROVED' }] }));
  const keyBefore = triageInputKey(ctx);
  const g = guideFor(ctx);
  const prompt = buildPrompt([{ id: 'i1', title: 't', url: '', summary: 's', tags: [] }], ['app — x — y'], { a: 0.3, b: 0.45, c: 0.05, d: 0.2 }, new Map(), g);
  assert.match(prompt, /SENTINEL-APPROVED/);
  assert.match(prompt, /SENTINEL-RULE/);
  assert.match(prompt, /decision-triage: 결정필요 정리 SENTINEL-SKILL/);
  assert.match(prompt, /c to a.*추천 c -> 태우님 a.*상시 창구로 이미 구현/);
  // disagreements come before agreements
  assert.ok(prompt.indexOf('c to a') < prompt.indexOf('agreed one'));
  // the guide is part of the input key: a newly approved rule re-classifies the week
  fs.writeFileSync(atticPath(ctx.vault, 'rules', 'triage-rules.json'), JSON.stringify({ rules: [{ id: 'r1', text: 'x' }, { id: 'r2', text: 'y' }] }));
  assert.notEqual(triageInputKey(ctx), keyBefore);
});

test('no guide configured and no answers: the prompt still builds (no empty sections)', () => {
  const ctx = ctxWithVault();
  const g = guideFor(ctx);
  const prompt = buildPrompt([{ id: 'i1', title: 't', url: '', summary: 's', tags: [] }], [], { a: 0.3, b: 0.45, c: 0.05, d: 0.2 }, new Map(), g);
  assert.doesNotMatch(prompt, /태우님이 고른 최근 답/);
  assert.match(prompt, /출력 스키마/);
});

test('b/d and "new models" cards are off by default; config turns them back on', () => {
  const tri = { items: [
    { id: 'i1', title: 'B', url: 'https://b.test', class: 'b', reason: 'r' },
    { id: 'i2', title: 'D', file: 'Refs/d.md', class: 'd', reason: 'r' },
    { id: 'i3', title: 'C', url: 'https://c.test', class: 'c', action: 'learn', minutes: 30, reason: 'r' },
  ] };
  const aud = { suggestions: [], models: {}, tools: {}, scannedFiles: 0 };
  const events = [{ kind: 'new', id: 'm/x', source: 'openrouter', detail: 'd' }];
  const off = buildDescriptors(tri, aud, {}, events, new Map(), {}).map((d) => d.payload.op);
  assert.deepEqual(off, ['queue_teach']);
  const on = buildDescriptors(tri, aud, {}, events, new Map(), { autoCards: true, systemReview: true }).map((d) => d.payload.op).sort();
  assert.deepEqual(on, ['archive_note', 'note_auto', 'queue_teach', 'system_review']);
});

test('rule cards: uncovered disagreements -> LLM -> add_triage_rule cards; approval writes the rule, which the next prompt uses', async () => {
  const ctx = ctxWithVault();
  ctx.env.FAKE_LLM_MODE = 'rules';
  const s = seed(ctx.vault);
  const led = buildLedger(ctx.vault, { now: LATER });
  const open = uncoveredDisagreements(led.entries, ctx.vault);
  assert.equal(open.length, 4);
  const ds = await ruleDescriptors(ctx, led.entries);
  assert.ok(ds.length >= 1 && ds.length <= 3);
  assert.equal(ds[0].payload.op, 'add_triage_rule');
  assert.ok(ds[0].payload.basedOn.every((id) => open.some((e) => e.id === id)));
  const p = createProposal(ctx.vault, { ...ds[0], source: 'review' }, LATER).proposal;
  // a pending rule card covers its cases: no second card for the same answers
  assert.equal(uncoveredDisagreements(led.entries, ctx.vault).filter((e) => ds[0].payload.basedOn.includes(e.id)).length, 0);
  // silence never adds a rule (not auto-applicable)
  decide(ctx.vault, p.id, 'approved', { by: 'cli', now: LATER });
  const r = await apply(ctx, { now: LATER });
  assert.ok(r.applied.some((x) => x.id === p.id && x.op === 'add_triage_rule'));
  assert.equal(readRules(ctx.vault).length, 1);
  assert.equal(readRules(ctx.vault)[0].text, ds[0].payload.text);
  assert.equal(getProposal(ctx.vault, p.id).status, 'applied');
  // applying twice does not duplicate
  await apply(ctx, { now: LATER });
  assert.equal(readRules(ctx.vault).length, 1);
  assert.match(guideFor(ctx).text, new RegExp(ds[0].payload.text.slice(0, 10)));
  void s;
});

test('rule cards: fewer than two uncovered disagreements -> no LLM call, no card', async () => {
  const ctx = ctxWithVault();
  ctx.env.FAKE_LLM_MODE = 'rules'; // would make a card if it were called
  const p = createProposal(ctx.vault, { ...teach('only one'), source: 'review' }, T0).proposal;
  reclassify(ctx.vault, p.id, 'a', { by: 'decision-api', now: LATER });
  const led = buildLedger(ctx.vault, { now: LATER });
  assert.deepEqual(await ruleDescriptors(ctx, led.entries), []);
});

test('retro shows the weekly agreement rate', () => {
  const ctx = ctxWithVault();
  seed(ctx.vault);
  const led = buildLedger(ctx.vault, { now: LATER });
  const r = compute({ triages: [], proposals: [], teachNotes: [], sourcesConfigured: [], month: '2026-11', now: LATER, feedback: weeklyMetrics(led.entries, ctx.vault) });
  const md = renderRetro(r, [], true);
  assert.match(md, /추천 일치율/);
  assert.match(md, /2026-W45 \| 5 \| 1 \| 20%/);
});
