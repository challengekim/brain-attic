import test from 'node:test';
import assert from 'node:assert/strict';
import { testCtx, startServer } from './helpers.mjs';
import { createProposal, getProposal, withdraw } from '../src/proposals.mjs';
import { dispatch, resendUnsent } from '../src/notify/index.mjs';

// A card that could not reach the app (down, offline) must not wait for the next weekly review: the hourly tick re-sends it.

function app({ fail = false } = {}) {
  const log = [];
  const state = { fail };
  return startServer((req, res, body) => {
    log.push({ method: req.method, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    if (state.fail) { res.statusCode = 503; res.end('{"error":"down"}'); return; }
    res.end(JSON.stringify(req.method === 'GET' ? { data: { answers: [] } } : { ok: true }));
  }).then((s) => ({ ...s, log, state }));
}
const setup = (s) => testCtx({
  env: { ATTIC_TEST_TOKEN: 't' },
  config: { notifiers: [{ type: 'decision-api', baseUrl: s.url, tokenEnv: 'ATTIC_TEST_TOKEN', kind: 'knowledge' }] },
});
const retroCard = (ctx, category) => createProposal(ctx.vault, {
  kind: 'retro-criteria', source: 'retro', summary: [`"${category}" 제안의 승인율이 0% 입니다. 분류/제안 기준을 조정할까요?`],
  payload: { op: 'adjust_criteria', category, approvalRate: 0, prompt: 'x' },
}).proposal;
const posts = (s) => s.log.filter((e) => e.method === 'POST').map((e) => e.body.changeId);

test('a card whose send failed is re-sent by the next tick, exactly once', async () => {
  const s = await app({ fail: true });
  const ctx = setup(s);
  const a = retroCard(ctx, 'try'), b = retroCard(ctx, 'improve');
  const r = await dispatch(ctx, { title: 'retro', text: 'x' }, [a, b]);
  assert.equal(r[0].ok, false);
  // known-bad: nothing reached the app, and before this fix nothing would retry until the next review
  assert.equal(getProposal(ctx.vault, a.id).external?.['decision-api'], undefined);
  assert.ok(getProposal(ctx.vault, a.id).offeredAt);

  // still down: the retry fails quietly and keeps the cards unsent
  const down = await resendUnsent(ctx);
  assert.equal(down[0].ok, false);

  s.state.fail = false;
  s.log.length = 0;
  const up = await resendUnsent(ctx);
  assert.deepEqual(up.map((x) => [x.type, x.sent]), [['decision-api', 2]]);
  assert.deepEqual(posts(s).sort(), [a.id, b.id].sort());
  assert.ok(getProposal(ctx.vault, b.id).external['decision-api'].sentAt);

  s.log.length = 0;
  assert.deepEqual(await resendUnsent(ctx), []);
  assert.equal(s.log.length, 0);
  await s.close();
});

test('only offered, pending, unexpired cards are re-sent', async () => {
  const s = await app();
  const ctx = setup(s);
  // created but never offered (a review run still building/deduplicating its cards): not sent early
  retroCard(ctx, 'notyet');
  // offered then withdrawn: not sent
  const w = retroCard(ctx, 'gone');
  const live = retroCard(ctx, 'live');
  s.state.fail = true;
  await dispatch(ctx, { title: 'retro', text: 'x' }, [w, live]);
  withdraw(ctx.vault, w.id, { by: 'test', reason: 'test' });
  s.state.fail = false;
  s.log.length = 0;
  // past its deadline: not sent
  const late = new Date(Date.parse(getProposal(ctx.vault, live.id).expiresAt) + 1000);
  assert.deepEqual(await resendUnsent(ctx, late), []);
  assert.equal(s.log.length, 0);
  const r = await resendUnsent(ctx);
  assert.equal(r[0].sent, 1);
  assert.deepEqual(posts(s), [live.id]);
  await s.close();
});

test('a successful dispatch leaves nothing to re-send', async () => {
  const s = await app();
  const ctx = setup(s);
  const a = retroCard(ctx, 'try');
  await dispatch(ctx, { title: 'retro', text: 'x' }, [a]);
  s.log.length = 0;
  assert.deepEqual(await resendUnsent(ctx), []);
  assert.equal(s.log.length, 0);
  await s.close();
});
