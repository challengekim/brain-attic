// Regression tests for the second independent review (2026-10-08): three bypasses left after the first fixes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCtx, startServer } from './helpers.mjs';
import { createProposal, getProposal, saveProposal, decide } from '../src/proposals.mjs';
import * as api from '../src/notify/decision-api.mjs';
import { writeFileAtomic } from '../src/util.mjs';
import { teach } from '../src/teach.mjs';

const mk = (title) => ({ kind: 'teach', summary: [`읽기: ${title}`], payload: { op: 'queue_teach', title } });
const cfgFor = (s) => ({ type: 'decision-api', baseUrl: s.url + '/', tokenEnv: 'ATTIC_TEST_TOKEN', kind: 'knowledge' });
function mock(answers) {
  const log = [];
  return startServer((req, res, body) => {
    log.push({ method: req.method, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.method === 'GET' ? { ok: true, data: { answers } } : { ok: true }));
  }).then((s) => ({ ...s, log }));
}

test('[r2-6] a revived proposal gets a new remote id; the old generation answer is acked but never applied', async () => {
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' } });
  const t0 = new Date('2026-09-01T00:00:00Z');
  const first = createProposal(ctx.vault, mk('X'), t0).proposal;
  first.external = { 'decision-api': { sentAt: t0.toISOString(), changeId: first.id } };
  saveProposal(ctx.vault, first);
  // expire, then revive the same content
  decide(ctx.vault, first.id, 'approved', { now: new Date('2026-09-20T00:00:00Z') });
  assert.equal(getProposal(ctx.vault, first.id).status, 'expired');
  const revived = createProposal(ctx.vault, mk('X'), new Date()).proposal;
  assert.equal(revived.id, first.id);
  assert.equal(revived.generation, 2);
  assert.equal(api.changeIdOf(revived), `${first.id}-g2`);

  const s = await mock([]);
  await api.publish(ctx, cfgFor(s), [revived]);
  await s.close();
  assert.equal(s.log.find((e) => e.method === 'POST').body.changeId, `${first.id}-g2`);

  // the app still holds an uncollected approval for generation 1
  const s2 = await mock([{ changeId: first.id, kind: 'knowledge', approved: true, answeredAt: '2026-09-02T00:00:00Z' }]);
  const r = await api.pull(ctx, cfgFor(s2));
  await s2.close();
  assert.equal(getProposal(ctx.vault, first.id).status, 'pending', 'old-generation approval must not apply');
  assert.deepEqual(r.changed, []);
  assert.deepEqual(s2.log.find((e) => e.method === 'PATCH').body.changeIds, [first.id], 'stale answer is acked so it stops coming back');
});

test('[r2-6] an answer dated before this generation was sent is not applied', async () => {
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' } });
  const p = createProposal(ctx.vault, mk('Y')).proposal;
  p.external = { 'decision-api': { sentAt: '2026-10-08T05:00:00Z', changeId: p.id } };
  saveProposal(ctx.vault, p);
  const s = await mock([{ changeId: p.id, kind: 'knowledge', approved: true, answeredAt: '2026-10-08T04:00:00Z' }]);
  await api.pull(ctx, cfgFor(s));
  await s.close();
  assert.equal(getProposal(ctx.vault, p.id).status, 'pending');
});

test('[r2-7] atomic write uses an exclusive, unpredictable temp file (no planted-symlink redirect)', () => {
  const dir = fs.mkdtempSync(path.join(testCtx().vault, 'w-'));
  const outside = path.join(dir, 'outside.txt');
  fs.writeFileSync(outside, 'keep');
  const target = path.join(dir, 'target.json');
  // The old scheme was `${target}.${pid}.${Date.now()}.tmp`; plant links for a range of plausible names.
  const now = Date.now();
  for (let i = -5; i < 200; i++) fs.symlinkSync(outside, `${target}.${process.pid}.${now + i}.tmp`);
  writeFileAtomic(target, '{"ok":true}\n');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  assert.equal(fs.readFileSync(target, 'utf8'), '{"ok":true}\n');
  const src = fs.readFileSync(new URL('../src/util.mjs', import.meta.url), 'utf8');
  assert.match(src, /openSync\(tmp, 'wx'/);
});

test('[r2-1] review of a file-made pack stays untrusted after the source file is deleted (codex refused)', async () => {
  const ctx = testCtx();
  const dir = path.join(ctx.vault, '_attic', 'teach');
  fs.mkdirSync(dir, { recursive: true });
  const pack = { title: 't', explanation: 'e', quiz: [{ question: 'q', choices: ['a', 'b', 'c', 'd'], answer: 0 }, { question: 'q2', choices: ['a', 'b', 'c', 'd'], answer: 0 }], teach_back: [{ prompt: 'p', rubric: ['r'] }] };
  for (const [slug, extra] of [['from-file', { sourceKind: 'file' }], ['legacy', {}]]) {
    fs.writeFileSync(path.join(dir, `${slug}.pack.json`), JSON.stringify({ pack, source: '/gone/file.md', sessions: [], ...extra }));
    ctx.config = { llm: { runner: 'codex' } };
    ctx.io = { print() {}, ask: async () => 'a', askMulti: async () => 'answer' };
    ctx.log = { info() {}, warn() {} };
    await assert.rejects(() => teach(['--review', slug], ctx), /codex/i, slug);
  }
});
