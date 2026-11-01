import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { testCtx, startServer, tmp, ROOT } from './helpers.mjs';
import { createProposal, getProposal, withdraw, reclassify } from '../src/proposals.mjs';
import { dispatch, resendUnsent } from '../src/notify/index.mjs';
import * as api from '../src/notify/decision-api.mjs';
import { tryRunLock, withRunLock } from '../src/runlock.mjs';
import { createHash } from 'node:crypto';

// A card that could not reach the app (down, offline) must not wait for the next weekly review: the hourly tick re-sends it.

function app({ fail = false, onPost } = {}) {
  const log = [];
  const state = { fail };
  return startServer(async (req, res, body) => {
    log.push({ method: req.method, body: body ? JSON.parse(body) : null });
    res.setHeader('content-type', 'application/json');
    if (state.fail) { res.statusCode = 503; res.end('{"error":"down"}'); return; }
    if (req.method === 'POST' && onPost) await onPost(JSON.parse(body));
    res.end(JSON.stringify(req.method === 'GET' ? { data: { answers: [] } } : { ok: true }));
  }).then((s) => ({ ...s, log, state }));
}
const cfgFor = (s) => ({ type: 'decision-api', baseUrl: s.url, tokenEnv: 'ATTIC_TEST_TOKEN', kind: 'knowledge' });
const setup = (s) => testCtx({ env: { ATTIC_TEST_TOKEN: 't' }, config: { notifiers: [cfgFor(s)] } });
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
  const w = retroCard(ctx, 'gone');
  const live = retroCard(ctx, 'live');
  s.state.fail = true;
  await dispatch(ctx, { title: 'retro', text: 'x' }, [w, live]);
  withdraw(ctx.vault, w.id, { by: 'test', reason: 'test' });
  s.state.fail = false;
  s.log.length = 0;
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
  await dispatch(ctx, { title: 'retro', text: 'x' }, [retroCard(ctx, 'try')]);
  s.log.length = 0;
  assert.deepEqual(await resendUnsent(ctx), []);
  assert.equal(s.log.length, 0);
  await s.close();
});

test('a stale caller copy never overwrites a withdraw or skips a card already answered', async () => {
  let ctx;
  const target = {};
  const s = await app({ onPost: (b) => { if (b.changeId === target.id) withdraw(ctx.vault, target.id, { by: 'test', reason: '전송 중 철회' }); } });
  ctx = setup(s);
  const p = retroCard(ctx, 'try');
  target.id = p.id;
  await api.publish(ctx, cfgFor(s), [p]);
  const after = getProposal(ctx.vault, p.id);
  assert.equal(after.status, 'withdrawn'); // the withdraw made during the send survives
  assert.ok(after.external['decision-api'].sentAt); // and the send is still recorded truthfully

  // the caller read it before it was answered: not sent at all
  const q = retroCard(ctx, 'improve');
  const stale = getProposal(ctx.vault, q.id);
  withdraw(ctx.vault, q.id, { by: 'test', reason: 'x' });
  s.log.length = 0;
  await api.publish(ctx, cfgFor(s), [stale]);
  assert.equal(s.log.length, 0);
  assert.equal(getProposal(ctx.vault, q.id).status, 'withdrawn');
  await s.close();
});

test('a reclassify (new generation) during the send is not reverted to the old generation', async () => {
  let ctx;
  const target = {};
  const s = await app({ onPost: (b) => { if (b.changeId === target.id) reclassify(ctx.vault, target.id, 'b', { by: 'test' }); } });
  ctx = setup(s);
  const p = createProposal(ctx.vault, { kind: 'teach', summary: ['읽기: A'], payload: { op: 'queue_teach', title: 'A', file: 'A.md' } }).proposal;
  target.id = p.id;
  await api.publish(ctx, cfgFor(s), [p]);
  const after = getProposal(ctx.vault, p.id);
  assert.equal(after.generation, 2);
  assert.equal(after.payload.op, 'note_auto');
  assert.equal(after.external?.['decision-api'], undefined); // the new generation is unsent, so it gets its own card
  await s.close();
});

test('run lock: one holder at a time, a dead owner\'s lock is taken over', async () => {
  const ctx = testCtx();
  const release = tryRunLock(ctx.vault);
  assert.ok(release);
  assert.equal(tryRunLock(ctx.vault), null);
  await assert.rejects(withRunLock(ctx.vault, async () => 1, { waitMs: 30, pollMs: 10 }), /기다리다 멈췄습니다/);
  release();
  assert.equal(await withRunLock(ctx.vault, async () => 7), 7);
  const file = path.join(ctx.vault, '_attic', 'state', 'run.lock');
  fs.writeFileSync(file, '999999999');
  const again = tryRunLock(ctx.vault);
  assert.ok(again, 'stale lock is reclaimed');
  again();
  assert.equal(fs.existsSync(file), false);
});

test('run lock: a lock still being created (empty, fresh) is held; an empty lock left by a crash is reclaimed', () => {
  const ctx = testCtx();
  const release = tryRunLock(ctx.vault);
  release();
  const file = path.join(ctx.vault, '_attic', 'state', 'run.lock');
  fs.writeFileSync(file, ''); // another process between open('wx') and writing its pid
  assert.equal(tryRunLock(ctx.vault), null);
  assert.equal(fs.existsSync(file), true); // not deleted from under its owner
  const old = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(file, old, old);
  const again = tryRunLock(ctx.vault);
  assert.ok(again);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  again();
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n === 'run.lock' || n.includes('stale')), []); // no leftovers
});

test('attic tick skips the hour while another run holds the lock', () => {
  const home = tmp();
  const vault = path.join(home, 'vault');
  fs.mkdirSync(path.join(vault, '_attic', 'state'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
  const tick = () => spawnSync(process.execPath, [path.join(ROOT, 'bin/attic.mjs'), 'tick', '--vault', vault], { env, encoding: 'utf8' });
  const lock = path.join(vault, '_attic', 'state', 'run.lock');
  fs.writeFileSync(lock, String(process.pid)); // a live owner (this test process)
  const held = tick();
  assert.equal(held.status, 0, held.stderr);
  assert.equal(JSON.parse(held.stdout.trim()).locked, true);
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid)); // not taken or removed
  fs.unlinkSync(lock);
  const free = tick();
  assert.equal(free.status, 0, free.stderr);
  const out = JSON.parse(free.stdout.trim());
  assert.equal(out.locked, undefined);
  assert.deepEqual(out.resent, []);
  assert.equal(fs.existsSync(lock), false); // released
});

test('run lock: a stale lock is reclaimed by exactly one contender; a paused contender never moves a live lock', () => {
  const ctx = testCtx();
  const dir = path.join(ctx.vault, '_attic', 'state');
  const file = path.join(dir, 'run.lock');
  tryRunLock(ctx.vault)(); // creates the state dir
  fs.writeFileSync(file, '999999999'); // dead owner
  // another contender already holds the reclaim token for this stale file: back off, leave the file alone
  const st = fs.statSync(file);
  const token = path.join(dir, 'run.lock.reclaim-' + createHash('sha256').update(`${st.ino}:${st.mtimeMs}:999999999`).digest('hex').slice(0, 32));
  fs.mkdirSync(token);
  assert.equal(tryRunLock(ctx.vault), null);
  assert.equal(fs.readFileSync(file, 'utf8'), '999999999');
  fs.rmdirSync(token);
  // the winner reclaims it and holds a fresh lock
  const b = tryRunLock(ctx.vault);
  assert.ok(b);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  // a late contender (inspected the stale file before) finds the token taken and the path holding a live lock: nothing moves
  assert.equal(tryRunLock(ctx.vault), null);
  assert.equal(fs.readFileSync(file, 'utf8'), String(process.pid));
  b();
  // tokens older than a day are swept on the next successful take
  const tokens = () => fs.readdirSync(dir).filter((n) => n.startsWith('run.lock.reclaim-'));
  assert.equal(tokens().length, 1);
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(dir, tokens()[0]), old, old);
  tryRunLock(ctx.vault)();
  assert.deepEqual(tokens(), []);
});
