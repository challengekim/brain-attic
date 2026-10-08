import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmp, testCtx } from './helpers.mjs';
import { createProposal, getProposal, saveProposal } from '../src/proposals.mjs';
import * as gi from '../src/notify/github-issues.mjs';

function fakeGh() {
  const dir = tmp('fakegh-');
  const log = path.join(dir, 'calls.log'), issues = path.join(dir, 'issues.json');
  fs.writeFileSync(issues, '{}');
  fs.writeFileSync(path.join(dir, 'gh'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const db = JSON.parse(fs.readFileSync(${JSON.stringify(issues)}, 'utf8'));
if (a[0] === 'api' && a[1] === 'user') { if (process.env.FAKE_GH_LOGIN === 'FAIL') process.exit(1); console.log(process.env.FAKE_GH_LOGIN || 'Owner'); }
else if (a[0] === 'issue' && a[1] === 'create') { console.log('https://github.com/o/r/issues/7'); }
else if (a[0] === 'issue' && a[1] === 'view') { console.log(JSON.stringify(db[a[2]] || { comments: [], labels: [], state: 'OPEN' })); }
`, { mode: 0o755 });
  return { dir, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)), setIssue: (n, v) => fs.writeFileSync(issues, JSON.stringify({ [n]: v })) };
}
const mk = () => ({ kind: 'improve', summary: ['스킬 X 를 개선할까?'], payload: { op: 'improve_candidate' } });

test('publish creates one issue with the attic-proposal label; republish is skipped', async () => {
  const gh = fakeGh();
  const ctx = testCtx({ env: { PATH: `${gh.dir}:${process.env.PATH}` } });
  const p = createProposal(ctx.vault, mk()).proposal;
  const cfg = { type: 'github-issues', repo: 'o/r' };
  const r = await gi.publish(ctx, cfg, [p]);
  assert.equal(r.sent, 1);
  const create = gh.calls().find((c) => c[0] === 'issue' && c[1] === 'create');
  assert.deepEqual(create.slice(create.indexOf('--repo'), create.indexOf('--repo') + 2), ['--repo', 'o/r']);
  assert.equal(create[create.indexOf('--label') + 1], 'attic-proposal');
  assert.match(create[create.indexOf('--body') + 1], new RegExp(p.id));
  assert.equal(getProposal(ctx.vault, p.id).external['github-issues'].number, 7);
  const r2 = await gi.publish(ctx, cfg, [getProposal(ctx.vault, p.id)]);
  assert.equal(r2.sent, 0);
});

test('pull: an "approve" comment approves, then labels attic-applied and closes', async () => {
  const gh = fakeGh();
  const ctx = testCtx({ env: { PATH: `${gh.dir}:${process.env.PATH}` } });
  const cfg = { type: 'github-issues', repo: 'o/r' };
  const p = createProposal(ctx.vault, mk()).proposal;
  await gi.publish(ctx, cfg, [p]);
  gh.setIssue('7', { state: 'OPEN', labels: [{ name: 'attic-proposal' }], comments: [{ body: 'hmm', author: { login: 'x' } }, { body: 'approve', author: { login: 'owner' } }] });
  const r = await gi.pull(ctx, cfg);
  assert.deepEqual(r.changed, [p.id]);
  assert.equal(getProposal(ctx.vault, p.id).status, 'approved');
  const calls = gh.calls();
  const edit = calls.find((c) => c[1] === 'edit');
  assert.equal(edit[edit.indexOf('--add-label') + 1], 'attic-applied');
  assert.ok(calls.some((c) => c[1] === 'close' && c[2] === '7'));
  // done: a second pull does not touch the issue again
  const n = gh.calls().length;
  await gi.pull(ctx, cfg);
  assert.equal(gh.calls().length, n);
});

test('[4] publish stores the gh login as the only approver; a stranger comment never approves', async () => {
  const gh = fakeGh();
  const ctx = testCtx({ env: { PATH: `${gh.dir}:${process.env.PATH}`, FAKE_GH_LOGIN: 'me-user' } });
  const cfg = { type: 'github-issues', repo: 'o/r' }; // no allowedUsers
  const p = createProposal(ctx.vault, mk()).proposal;
  await gi.publish(ctx, cfg, [p]);
  assert.deepEqual(getProposal(ctx.vault, p.id).external['github-issues'].approvers, ['me-user']);
  assert.ok(gh.calls().some((c) => c[0] === 'api' && c[1] === 'user'));
  gh.setIssue('7', { state: 'OPEN', labels: [], comments: [{ body: 'approve', author: { login: 'stranger' } }] });
  await gi.pull(ctx, cfg);
  assert.equal(getProposal(ctx.vault, p.id).status, 'pending');
  gh.setIssue('7', { state: 'OPEN', labels: [], comments: [{ body: 'approve', author: { login: 'stranger' } }, { body: 'reject', author: { login: 'ME-USER' } }] });
  await gi.pull(ctx, cfg);
  assert.equal(getProposal(ctx.vault, p.id).status, 'rejected');
});

test('[4] an EMPTY approver list approves nobody (even the "owner")', async () => {
  const gh = fakeGh();
  const ctx = testCtx({ env: { PATH: `${gh.dir}:${process.env.PATH}` } });
  const cfg = { type: 'github-issues', repo: 'o/r', allowedUsers: [] };
  const p = createProposal(ctx.vault, mk()).proposal;
  await gi.publish(ctx, cfg, [p]);
  const rec = getProposal(ctx.vault, p.id);
  rec.external['github-issues'].approvers = []; saveProposal(ctx.vault, rec); // tampered / legacy record
  gh.setIssue('7', { state: 'OPEN', labels: [], comments: [{ body: 'approve', author: { login: 'owner' } }, { body: 'approve', author: null }] });
  const r = await gi.pull(ctx, cfg);
  assert.deepEqual(r.changed, []);
  assert.equal(getProposal(ctx.vault, p.id).status, 'pending');
});

test('[4] label-based approval is gone: approve/reject labels are ignored', async () => {
  const gh = fakeGh();
  const ctx = testCtx({ env: { PATH: `${gh.dir}:${process.env.PATH}` } });
  const cfg = { type: 'github-issues', repo: 'o/r' };
  const p = createProposal(ctx.vault, mk()).proposal;
  await gi.publish(ctx, cfg, [p]);
  gh.setIssue('7', { state: 'OPEN', labels: [{ name: 'approve' }, { name: 'approved' }, { name: 'reject' }], comments: [] });
  const r = await gi.pull(ctx, cfg);
  assert.deepEqual(r.changed, []);
  assert.equal(getProposal(ctx.vault, p.id).status, 'pending');
  const view = gh.calls().find((c) => c[1] === 'view');
  assert.ok(!view.join(',').includes('labels'), 'labels are not even requested');
});

test('[4] config.allowedUsers wins over the stored login; publish fails closed when gh cannot name the user', async () => {
  const gh = fakeGh();
  const ctx = testCtx({ env: { PATH: `${gh.dir}:${process.env.PATH}` } });
  const cfg = { type: 'github-issues', repo: 'o/r', allowedUsers: ['boss'] };
  const p = createProposal(ctx.vault, mk()).proposal;
  await gi.publish(ctx, cfg, [p]);
  gh.setIssue('7', { state: 'OPEN', labels: [], comments: [{ body: '/approve', author: { login: 'owner' } }, { body: 'approve.', author: { login: 'Boss' } }] });
  await gi.pull(ctx, cfg);
  assert.equal(getProposal(ctx.vault, p.id).status, 'approved');
  const ctx2 = testCtx({ env: { PATH: `${gh.dir}:${process.env.PATH}`, FAKE_GH_LOGIN: 'FAIL' } });
  const p2 = createProposal(ctx2.vault, mk()).proposal;
  await assert.rejects(gi.publish(ctx2, { type: 'github-issues', repo: 'o/r' }, [p2]), /승인자/);
  assert.equal(getProposal(ctx2.vault, p2.id).external['github-issues'], undefined);
});

test('[5] pull only touches issues WE created for this repo (a proposal with no/other-repo issue record is skipped)', async () => {
  const gh = fakeGh();
  const ctx = testCtx({ env: { PATH: `${gh.dir}:${process.env.PATH}` } });
  const cfg = { type: 'github-issues', repo: 'o/r', allowedUsers: ['owner'] };
  const unsent = createProposal(ctx.vault, mk()).proposal;
  const other = createProposal(ctx.vault, { ...mk(), summary: ['다른 것'] }).proposal;
  other.external = { 'github-issues': { number: 9, repo: 'x/y', approvers: ['owner'] } }; saveProposal(ctx.vault, other);
  gh.setIssue('7', { state: 'OPEN', labels: [], comments: [{ body: 'approve', author: { login: 'owner' } }] });
  gh.setIssue('9', { state: 'OPEN', labels: [], comments: [{ body: 'approve', author: { login: 'owner' } }] });
  const r = await gi.pull(ctx, cfg);
  assert.deepEqual(r.changed, []);
  assert.equal(gh.calls().filter((c) => c[1] === 'view').length, 0);
  assert.equal(getProposal(ctx.vault, unsent.id).status, 'pending');
});

test('[6] an approve comment on a TTL-expired proposal expires it instead of approving', async () => {
  const gh = fakeGh();
  const ctx = testCtx({ env: { PATH: `${gh.dir}:${process.env.PATH}` } });
  const cfg = { type: 'github-issues', repo: 'o/r', allowedUsers: ['owner'] };
  const p = createProposal(ctx.vault, mk(), new Date('2026-01-01T00:00:00Z')).proposal;
  await gi.publish(ctx, cfg, [p]);
  gh.setIssue('7', { state: 'OPEN', labels: [], comments: [{ body: 'approve', author: { login: 'owner' } }] });
  const r = await gi.pull(ctx, cfg);
  assert.deepEqual(r.changed, []);
  assert.equal(getProposal(ctx.vault, p.id).status, 'expired');
});

test('no gh on PATH -> clear error', async () => {
  const ctx = testCtx({ env: { PATH: '/nonexistent' } });
  await assert.rejects(gi.publish(ctx, { repo: 'o/r' }, []), /gh CLI/);
});
