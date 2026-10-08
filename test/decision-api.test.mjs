import test from 'node:test';
import assert from 'node:assert/strict';
import { testCtx, startServer } from './helpers.mjs';
import { createProposal, getProposal, saveProposal, decide } from '../src/proposals.mjs';
import * as api from '../src/notify/decision-api.mjs';

function mock(answersFor) {
  const log = [];
  return startServer((req, res, body) => {
    const entry = { method: req.method, url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null };
    log.push(entry);
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') res.end(JSON.stringify(answersFor(entry)));
    else res.end(JSON.stringify({ ok: true }));
  }).then((s) => ({ ...s, log }));
}
const cfgFor = (s) => ({ type: 'decision-api', baseUrl: s.url + '/', tokenEnv: 'ATTIC_TEST_TOKEN', kind: 'knowledge' });
/** Pretend the proposal went out through this adapter (what publish() records). */
const sent = (ctx, p) => { p.external = { ...p.external, 'decision-api': { sentAt: '2026-10-01T00:00:00Z' } }; saveProposal(ctx.vault, p); return p; };
const mk = (title) => ({ kind: 'teach', summary: [`읽기: ${title}`, `이유: ${title}`], payload: { op: 'queue_teach', title } });

test('publish: POST contract (changeId, kind, summary lines, payload, Bearer)', async () => {
  const s = await mock(() => ({ data: { answers: [] } }));
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 'secret-token-value' } });
  const p = createProposal(ctx.vault, { ...mk('A'), summary: ['x'.repeat(500), '', 'second'] }).proposal;
  await api.publish(ctx, cfgFor(s), [p]);
  await s.close();
  const post = s.log.find((e) => e.method === 'POST');
  assert.equal(post.url, '/api/agent-decisions/sync');
  assert.equal(post.auth, 'Bearer secret-token-value');
  assert.equal(post.body.changeId, p.id);
  assert.equal(post.body.kind, 'knowledge');
  assert.equal(post.body.summary.length, 2);
  assert.ok(post.body.summary.every((l) => l.length > 0 && l.length <= 300));
  assert.equal(post.body.payload.op, 'queue_teach');
  // second publish of the same proposal is skipped
  const s2 = await mock(() => ({}));
  await api.publish(ctx, cfgFor(s2), [getProposal(ctx.vault, p.id)]);
  await s2.close();
  assert.equal(s2.log.length, 0);
});

for (const [name, wrap] of [
  ['{ok,data:{ttlDays,answers}}', (a) => ({ ok: true, data: { ttlDays: 7, answers: a } })],
  ['{data:{answers}}', (a) => ({ data: { answers: a } })],
  ['{answers} (no wrapper)', (a) => ({ answers: a })],
]) {
  test(`pull handles response shape ${name}; ignores foreign ids; acks only ours`, async () => {
    const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' } });
    const mine = sent(ctx, createProposal(ctx.vault, mk('mine')).proposal);
    const mine2 = sent(ctx, createProposal(ctx.vault, mk('mine2')).proposal);
    const answers = [
      { changeId: mine.id, kind: 'knowledge', payload: {}, approved: true, answeredAt: '2026-10-08T01:00:00Z', createdAt: 'x' },
      { changeId: 'config-999-someone-else', kind: 'knowledge', payload: {}, approved: true, answeredAt: 'x', createdAt: 'x' },
      { changeId: mine2.id, kind: 'knowledge', payload: {}, approved: false, answeredAt: 'x', createdAt: 'x' },
      { changeId: 'attic-foreign000', kind: 'knowledge', approved: true },
    ];
    const s = await mock(() => wrap(answers));
    const r = await api.pull(ctx, cfgFor(s));
    await s.close();
    const get = s.log.find((e) => e.method === 'GET');
    assert.equal(get.url, '/api/agent-decisions/sync?kind=knowledge');
    const patch = s.log.find((e) => e.method === 'PATCH');
    assert.deepEqual(patch.body, { changeIds: [mine.id, mine2.id], kind: 'knowledge' });
    assert.deepEqual(r.ignored.sort(), ['attic-foreign000', 'config-999-someone-else']);
    assert.equal(getProposal(ctx.vault, mine.id).status, 'approved');
    assert.equal(getProposal(ctx.vault, mine2.id).status, 'rejected');
  });
}

test('pull: nothing local -> no PATCH at all; answers with another kind are ignored', async () => {
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' } });
  const mine = sent(ctx, createProposal(ctx.vault, mk('mine')).proposal);
  const s = await mock(() => ({ data: { answers: [{ changeId: 'config-1', kind: 'config', approved: true }, { changeId: mine.id, kind: 'config', approved: true }] } }));
  const r = await api.pull(ctx, cfgFor(s));
  await s.close();
  assert.equal(s.log.filter((e) => e.method === 'PATCH').length, 0);
  assert.equal(r.acked.length, 0);
  assert.equal(getProposal(ctx.vault, mine.id).status, 'pending');
});

test('pull: an already-decided local id is acked but its status is not overwritten', async () => {
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' } });
  const p = sent(ctx, createProposal(ctx.vault, mk('x')).proposal);
  decide(ctx.vault, p.id, 'rejected');
  const s = await mock(() => ({ answers: [{ changeId: p.id, kind: 'knowledge', approved: true }] }));
  await api.pull(ctx, cfgFor(s));
  await s.close();
  assert.equal(getProposal(ctx.vault, p.id).status, 'rejected');
  assert.deepEqual(s.log.find((e) => e.method === 'PATCH').body.changeIds, [p.id]);
});

test('missing token env var -> clear error, token value never in message', async () => {
  const ctx = testCtx();
  await assert.rejects(api.pull(ctx, { baseUrl: 'http://127.0.0.1:1', tokenEnv: 'NOPE_TOKEN' }), /NOPE_TOKEN/);
});

test('[5] pull: a LOCAL proposal never published through decision-api is neither decided nor acked', async () => {
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' } });
  const unsent = createProposal(ctx.vault, mk('unsent')).proposal; // exists locally, no external record
  const github = createProposal(ctx.vault, mk('gh')).proposal;
  github.external = { 'github-issues': { number: 3, repo: 'o/r' } }; saveProposal(ctx.vault, github);
  const s = await mock(() => ({ answers: [{ changeId: unsent.id, kind: 'knowledge', approved: true }, { changeId: github.id, kind: 'knowledge', approved: true }] }));
  const r = await api.pull(ctx, cfgFor(s));
  await s.close();
  assert.equal(s.log.filter((e) => e.method === 'PATCH').length, 0);
  assert.deepEqual(r.acked, []);
  assert.deepEqual(r.ignored.sort(), [github.id, unsent.id].sort());
  assert.equal(getProposal(ctx.vault, unsent.id).status, 'pending');
  assert.equal(getProposal(ctx.vault, github.id).status, 'pending');
});

test('[5][6] pull: an answer for an expired-TTL proposal does not approve it (but is acked)', async () => {
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' } });
  const p = sent(ctx, createProposal(ctx.vault, { kind: 'improve', summary: ['개선: old'], payload: { op: 'improve_candidate', file: 'old.md' } }, new Date('2026-01-01T00:00:00Z')).proposal);
  const s = await mock(() => ({ answers: [{ changeId: p.id, kind: 'knowledge', approved: true }] }));
  const r = await api.pull(ctx, cfgFor(s));
  await s.close();
  assert.equal(getProposal(ctx.vault, p.id).status, 'expired');
  assert.deepEqual(r.changed, []);
  assert.deepEqual(r.acked, [p.id]);
});

// ---------------------------------------------------------------- "change class" on the card (LCC reclassifyTo)

const cls = (op, extra = {}) => ({ kind: op === 'queue_teach' ? 'teach' : op === 'note_auto' ? 'auto' : 'drop', summary: [`[x] ${op} ${JSON.stringify(extra)}`], payload: { op, title: 'T', url: 'https://e.test/1', kind: 'url', ...extra } });

test('publish: classification proposals carry a reclassify offer (d only for vault notes); system proposals do not', async () => {
  const s = await mock(() => ({}));
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' } });
  const c = createProposal(ctx.vault, cls('queue_teach')).proposal;
  const v = createProposal(ctx.vault, cls('note_auto', { file: 'Refs/n.md', kind: 'vault' })).proposal;
  const sys = createProposal(ctx.vault, { kind: 'source', summary: ['출처 추가'], payload: { op: 'add_source', name: 'X' } }).proposal;
  await api.publish(ctx, cfgFor(s), [c, v, sys]);
  await s.close();
  const body = (id) => s.log.find((e) => e.method === 'POST' && e.body.changeId === id).body;
  assert.deepEqual(body(c.id).reclassify, { current: 'c', options: [{ value: 'a', label: 'a 인지만' }, { value: 'b', label: 'b 자동 반영' }, { value: 'c', label: 'c 설명하기' }] });
  assert.deepEqual(body(v.id).reclassify.options.map((o) => o.value), ['a', 'b', 'c', 'd']);
  assert.equal(body(v.id).reclassify.current, 'b');
  assert.equal('reclassify' in body(sys.id), false);
});

test('pull: reclassifyTo b on a c proposal -> rewritten as note_auto and approved; acked', async () => {
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' } });
  const p = sent(ctx, createProposal(ctx.vault, cls('queue_teach')).proposal);
  const s = await mock(() => ({ data: { answers: [{ changeId: p.id, kind: 'knowledge', approved: true, reclassifyTo: 'b', answeredAt: new Date().toISOString() }] } }));
  const r = await api.pull(ctx, cfgFor(s));
  await s.close();
  const q = getProposal(ctx.vault, p.id);
  assert.equal(q.status, 'approved');
  assert.equal(q.payload.op, 'note_auto');
  assert.equal(q.userClass, 'b');
  assert.equal(q.recommended.class, 'c');
  assert.equal(q.decidedBy, 'decision-api');
  assert.deepEqual(r.changed, [p.id]);
  assert.deepEqual(s.log.find((e) => e.method === 'PATCH').body.changeIds, [p.id]);
});

test('pull: reclassifyTo a closes the proposal (rejected, reclassifiedTo a), nothing gets applied', async () => {
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' } });
  const p = sent(ctx, createProposal(ctx.vault, cls('queue_teach')).proposal);
  const s = await mock(() => ({ answers: [{ changeId: p.id, kind: 'knowledge', approved: true, reclassifyTo: 'a', answeredAt: new Date().toISOString() }] }));
  await api.pull(ctx, cfgFor(s));
  await s.close();
  const q = getProposal(ctx.vault, p.id);
  assert.equal(q.status, 'rejected');
  assert.equal(q.reclassifiedTo, 'a');
});

test('pull: reclassifyTo equal to the recommendation is a plain approve', async () => {
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' } });
  const p = sent(ctx, createProposal(ctx.vault, cls('queue_teach')).proposal);
  const s = await mock(() => ({ answers: [{ changeId: p.id, kind: 'knowledge', approved: true, reclassifyTo: 'c', answeredAt: new Date().toISOString() }] }));
  await api.pull(ctx, cfgFor(s));
  await s.close();
  const q = getProposal(ctx.vault, p.id);
  assert.equal(q.status, 'approved');
  assert.equal(q.payload.op, 'queue_teach');
});

test('pull: an unusable reclassifyTo (d without a file / system proposal) leaves the proposal pending but acks', async () => {
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' } });
  const p = sent(ctx, createProposal(ctx.vault, cls('queue_teach')).proposal);
  const sys = sent(ctx, createProposal(ctx.vault, { kind: 'source', summary: ['출처 추가'], payload: { op: 'add_source', name: 'X' } }).proposal);
  const now = new Date().toISOString();
  const s = await mock(() => ({ answers: [
    { changeId: p.id, kind: 'knowledge', approved: true, reclassifyTo: 'd', answeredAt: now },
    { changeId: sys.id, kind: 'knowledge', approved: true, reclassifyTo: 'b', answeredAt: now },
  ] }));
  const r = await api.pull(ctx, cfgFor(s));
  await s.close();
  assert.equal(getProposal(ctx.vault, p.id).status, 'pending');
  assert.equal(getProposal(ctx.vault, sys.id).status, 'pending');
  assert.deepEqual(r.ignored.sort(), [p.id, sys.id].sort());
  assert.deepEqual(s.log.find((e) => e.method === 'PATCH').body.changeIds.sort(), [p.id, sys.id].sort());
});

test('pull: a pick made inside the TTL but pulled after it still applies the picked class', async () => {
  const ctx = testCtx({ env: { ATTIC_TEST_TOKEN: 't' } });
  const created = new Date(Date.now() - 9 * 86400000);
  const p = createProposal(ctx.vault, cls('queue_teach'), created).proposal;
  p.external = { 'decision-api': { sentAt: created.toISOString() } }; saveProposal(ctx.vault, p);
  const answeredAt = new Date(created.getTime() + 2 * 86400000).toISOString();
  const s = await mock(() => ({ answers: [{ changeId: p.id, kind: 'knowledge', approved: true, reclassifyTo: 'b', answeredAt }] }));
  await api.pull(ctx, cfgFor(s));
  await s.close();
  const q = getProposal(ctx.vault, p.id);
  assert.equal(q.status, 'approved');
  assert.equal(q.payload.op, 'note_auto');
});
