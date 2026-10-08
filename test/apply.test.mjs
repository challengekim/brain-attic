import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { testCtx } from './helpers.mjs';
import { createProposal, decide, getProposal } from '../src/proposals.mjs';
import { apply, WHITELIST } from '../src/apply.mjs';
import { saveConfig, loadConfig } from '../src/config.mjs';
import { atticPath } from '../src/vault.mjs';

function setup(sources = []) {
  const ctx = testCtx({ config: { sources } });
  saveConfig(ctx.config, ctx.env, ctx.configPath);
  return ctx;
}
const prop = (ctx, payload, approve = true) => {
  const { proposal } = createProposal(ctx.vault, { kind: 'x', summary: [`s ${JSON.stringify(payload)}`], payload });
  if (approve) decide(ctx.vault, proposal.id, 'approved');
  return proposal.id;
};
const cfgNow = (ctx) => loadConfig(ctx.env, ctx.configPath);

test('whitelist is exactly the four documented ops', () => {
  assert.deepEqual(WHITELIST, ['add_source', 'remove_source', 'set_triage_budget', 'queue_teach']);
});

test('add_source / remove_source / set_triage_budget change config only after approval', async () => {
  const ctx = setup([{ type: 'rss', name: 'Old', url: 'https://old.test/feed' }]);
  const add = prop(ctx, { op: 'add_source', source: { type: 'github', repo: 'o/r', name: 'R' } });
  const rem = prop(ctx, { op: 'remove_source', match: 'Old' });
  const bud = prop(ctx, { op: 'set_triage_budget', weeklyMinutes: 90 });
  const pend = prop(ctx, { op: 'set_triage_budget', weeklyMinutes: 1 }, false);
  const r = await apply(ctx);
  assert.equal(r.applied.length, 3);
  const c = cfgNow(ctx);
  assert.deepEqual(c.sources.map((s) => s.name), ['R']);
  assert.equal(c.triage.weeklyMinutes, 90);
  for (const id of [add, rem, bud]) assert.equal(getProposal(ctx.vault, id).status, 'applied');
  assert.equal(getProposal(ctx.vault, pend).status, 'pending');
  // idempotent
  assert.equal((await apply(ctx)).applied.length, 0);
});

test('invalid payloads are refused and stay approved', async () => {
  const ctx = setup();
  const a = prop(ctx, { op: 'add_source', source: { type: 'rss', url: 'javascript:alert(1)' } });
  const b = prop(ctx, { op: 'set_triage_budget', weeklyMinutes: -5 });
  const r = await apply(ctx);
  assert.equal(r.errors.length, 2);
  assert.equal(getProposal(ctx.vault, a).status, 'approved');
  assert.equal(getProposal(ctx.vault, b).status, 'approved');
  assert.deepEqual(cfgNow(ctx).sources, []);
});

test('queue_teach appends to the teach queue once', async () => {
  const ctx = setup();
  prop(ctx, { op: 'queue_teach', title: 'T', url: 'https://t.test', minutes: 30 });
  await apply(ctx); await apply(ctx);
  const q = JSON.parse(fs.readFileSync(atticPath(ctx.vault, 'teach', 'queue.json'), 'utf8'));
  assert.equal(q.length, 1);
  assert.equal(q[0].title, 'T');
});

test('anything outside the whitelist only writes a prompt file and stays approved', async () => {
  const ctx = setup();
  const id = prop(ctx, { op: 'edit_skill', file: 'skills/x/SKILL.md', prompt: '이 스킬을 고쳐라' });
  const r = await apply(ctx);
  assert.equal(r.applied.length, 0);
  assert.equal(r.prompts.length, 1);
  const f = atticPath(ctx.vault, 'approved', `${id}.prompt.md`);
  assert.match(fs.readFileSync(f, 'utf8'), /이 스킬을 고쳐라/);
  assert.equal(getProposal(ctx.vault, id).status, 'approved');
  assert.deepEqual(cfgNow(ctx).sources, []);
});

test('pending / rejected proposals are never applied', async () => {
  const ctx = setup();
  prop(ctx, { op: 'set_triage_budget', weeklyMinutes: 5 }, false);
  const { proposal } = createProposal(ctx.vault, { kind: 'x', summary: ['r'], payload: { op: 'set_triage_budget', weeklyMinutes: 7 } });
  decide(ctx.vault, proposal.id, 'rejected');
  await apply(ctx);
  assert.equal(cfgNow(ctx).triage.weeklyMinutes, 180);
});
