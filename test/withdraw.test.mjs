import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { testCtx } from './helpers.mjs';
import { atticPath, ensureSkeleton } from '../src/vault.mjs';
import { isoWeek } from '../src/util.mjs';
import { createProposal, decide, expireStale, getProposal, withdraw } from '../src/proposals.mjs';
import { review } from '../src/review.mjs';
import { compute } from '../src/retro.mjs';
import * as api from '../src/notify/decision-api.mjs';
import { startServer } from './helpers.mjs';

const NOW = new Date('2026-10-08T08:30:00Z');
const teach = (title, reason = 'r') => ({ kind: 'teach', summary: [`깊게 읽고 설명해 볼 것: ${title}`, `이유: ${reason}`, '예상 30분'], payload: { op: 'queue_teach', title, url: `https://e.test/${encodeURIComponent(title)}`, kind: 'url', project: null, minutes: 30 }, source: 'review' });

test('withdraw: pending only; never applied, never auto-approved after the TTL', () => {
  const ctx = testCtx(); ensureSkeleton(ctx.vault);
  const p = createProposal(ctx.vault, teach('A'), NOW).proposal;
  const w = withdraw(ctx.vault, p.id, { reason: '중복', now: NOW });
  assert.equal(w.status, 'withdrawn');
  assert.equal(w.withdrawReason, '중복');
  assert.throws(() => withdraw(ctx.vault, p.id), /이미 withdrawn/);
  // 8 days later: an auto-applicable proposal would be auto-approved, a withdrawn one stays withdrawn
  expireStale(ctx.vault, new Date(NOW.getTime() + 8 * 86400000));
  assert.equal(getProposal(ctx.vault, p.id).status, 'withdrawn');
  assert.equal(decide(ctx.vault, p.id, 'approved').changed, false);
  const q = createProposal(ctx.vault, teach('B'), NOW).proposal;
  decide(ctx.vault, q.id, 'rejected');
  assert.throws(() => withdraw(ctx.vault, q.id), /이미 rejected/);
});

test('withdraw: the same content proposed again later is revived as a new generation', () => {
  const ctx = testCtx(); ensureSkeleton(ctx.vault);
  const p = createProposal(ctx.vault, teach('A'), NOW).proposal;
  withdraw(ctx.vault, p.id, { now: NOW });
  const { proposal, created } = createProposal(ctx.vault, teach('A'), NOW);
  assert.equal(created, false);
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.generation, 2);
});

test('decision-api: an answer to a withdrawn card is acked and changes nothing', async () => {
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' } }); ensureSkeleton(ctx.vault);
  const p = createProposal(ctx.vault, teach('A'), NOW).proposal;
  p.external = { 'decision-api': { sentAt: '2026-10-08T00:00:00Z', changeId: p.id } };
  fs.writeFileSync(atticPath(ctx.vault, 'proposals', `${p.id}.json`), JSON.stringify(p));
  withdraw(ctx.vault, p.id, { now: NOW });
  const log = [];
  const s = await startServer((req, res) => { log.push(req.method); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.method === 'GET' ? { answers: [{ changeId: p.id, kind: 'knowledge', approved: true, answeredAt: '2026-10-09T00:00:00Z' }] } : { ok: true })); });
  const r = await api.pull(ctx, { type: 'decision-api', baseUrl: s.url, tokenEnv: 'ATTIC_TEST_TOKEN', kind: 'knowledge' });
  await s.close();
  assert.equal(getProposal(ctx.vault, p.id).status, 'withdrawn');
  assert.deepEqual(r.acked, [p.id]);
});

test('retro: withdrawn proposals are not counted as decided (not a rejection)', () => {
  const base = { kind: 'teach', createdAt: '2026-10-05T00:00:00Z' };
  const r = compute({ triages: [], proposals: [{ ...base, status: 'withdrawn' }, { ...base, status: 'withdrawn' }, { ...base, status: 'approved' }], teachNotes: [], sourcesConfigured: [], month: '2026-10', now: new Date('2026-11-01T00:00:00Z') });
  const rate = JSON.stringify(r);
  assert.match(rate, /"decided":1/);
});

test('review re-run in the same week withdraws stale classification cards and older duplicates, keeps the rest', async () => {
  const ctx = testCtx({ config: { triage: { include: [] }, notifiers: [], audit: { paths: [] } } });
  ensureSkeleton(ctx.vault);
  const week = isoWeek(NOW);
  // First run of the week: c for A, B (and D), b for nothing.
  const first = new Date(NOW.getTime() - 7 * 60000);
  const a = createProposal(ctx.vault, teach('A', 'old reason'), first).proposal; // still c, reworded -> duplicate
  const b = createProposal(ctx.vault, teach('B'), first).proposal;               // now a -> stale
  const d = createProposal(ctx.vault, teach('D'), first).proposal;               // still c, same wording -> same id, kept
  const sys = createProposal(ctx.vault, { kind: 'source', summary: ['출처 추가'], payload: { op: 'add_source', name: 'X' }, source: 'review' }, first).proposal;
  // Final classification of the week (saved, newer than every input so review reuses it instead of calling a model)
  const item = (title, cls, reason = 'r') => ({ id: title, title, url: `https://e.test/${encodeURIComponent(title)}`, source: 'Feed', class: cls, project: null, reason, minutes: cls === 'c' ? 30 : undefined });
  const tri = { week, generatedAt: new Date(Date.now() + 3600000).toISOString(), weeklyMinutes: null, usedMinutes: 60, demoted: 0, errors: [], counts: { a: 1, b: 0, c: 2, d: 0, unclassified: 0 }, items: [item('A', 'c', 'new reason'), item('B', 'a'), item('D', 'c')] };
  fs.writeFileSync(atticPath(ctx.vault, 'triage', `${week}.json`), JSON.stringify(tri));
  const r = await review(ctx, { now: NOW });
  assert.equal(getProposal(ctx.vault, b.id).status, 'withdrawn', 'B is a now');
  assert.match(getProposal(ctx.vault, b.id).withdrawReason, /a/);
  assert.equal(getProposal(ctx.vault, a.id).status, 'withdrawn', 'old wording of A is a duplicate');
  assert.match(getProposal(ctx.vault, a.id).withdrawReason, /중복/);
  assert.equal(getProposal(ctx.vault, d.id).status, 'pending', 'D unchanged');
  assert.equal(getProposal(ctx.vault, sys.id).status, 'pending', 'system proposals are not touched');
  const newA = r.proposals.map((id) => getProposal(ctx.vault, id)).find((p) => p.payload.title === 'A');
  assert.equal(newA.status, 'pending');
  assert.notEqual(newA.id, a.id);
  assert.deepEqual(r.withdrawn.sort(), [a.id, b.id].sort());
});

test('review --dry-run withdraws nothing', async () => {
  const ctx = testCtx({ config: { triage: { include: [] }, notifiers: [], audit: { paths: [] } } });
  ensureSkeleton(ctx.vault);
  const week = isoWeek(NOW);
  const b = createProposal(ctx.vault, teach('B'), NOW).proposal;
  const tri = { week, generatedAt: new Date(Date.now() + 3600000).toISOString(), errors: [], counts: { a: 1, b: 0, c: 0, d: 0, unclassified: 0 }, items: [{ id: 'B', title: 'B', url: 'https://e.test/B', source: 'Feed', class: 'a', project: null, reason: 'r' }] };
  fs.writeFileSync(atticPath(ctx.vault, 'triage', `${week}.json`), JSON.stringify(tri));
  await review(ctx, { now: NOW, dryRun: true });
  assert.equal(getProposal(ctx.vault, b.id).status, 'pending');
});
