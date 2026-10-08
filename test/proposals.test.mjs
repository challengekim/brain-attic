import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCtx } from './helpers.mjs';
import { getInstanceId } from '../src/vault.mjs';
import { createProposal, proposalId, listProposals, expireStale, decide, isApplicable, getProposal, summaryLines, TTL_DAYS } from '../src/proposals.mjs';

const sys = { kind: 'improve', summary: ['개선 후보: X'], payload: { op: 'improve_candidate', file: 'x.md' } }; // changes the system -> expires, never auto-applied
const base = { kind: 'teach', summary: ['깊게 읽기: X'], payload: { op: 'queue_teach', title: 'X' } };

test('id is attic- + 12 hex of sha256(instanceId + content); idempotent; key order irrelevant', () => {
  const { vault } = testCtx();
  const a = proposalId(vault, base);
  assert.match(a, /^attic-[0-9a-f]{12}$/);
  assert.equal(a, proposalId(vault, { payload: { title: 'X', op: 'queue_teach' }, summary: ['깊게 읽기: X'], kind: 'teach' }));
  assert.notEqual(a, proposalId(vault, { ...base, payload: { op: 'queue_teach', title: 'Y' } }));
});

test('[5] same content in two vaults gets different ids (random per-vault instanceId, created once)', () => {
  const v1 = testCtx().vault, v2 = testCtx().vault;
  assert.notEqual(proposalId(v1, base), proposalId(v2, base));
  const inst = JSON.parse(fs.readFileSync(path.join(v1, '_attic/state/instance.json'), 'utf8'));
  assert.match(inst.instanceId, /^[0-9a-f-]{36}$/);
  assert.equal(getInstanceId(v1), inst.instanceId);
  assert.equal(proposalId(v1, base), proposalId(v1, base));
});

test('createProposal: same content -> same file, original createdAt kept; TTL is 7 days', () => {
  const ctx = testCtx();
  const t0 = new Date('2026-10-01T00:00:00Z');
  const r1 = createProposal(ctx.vault, base, t0);
  assert.equal(r1.created, true);
  assert.equal(r1.proposal.status, 'pending');
  assert.equal(r1.proposal.expiresAt, new Date(t0.getTime() + TTL_DAYS * 86400000).toISOString());
  const r2 = createProposal(ctx.vault, base, new Date('2026-10-03T00:00:00Z'));
  assert.equal(r2.created, false);
  assert.equal(r2.proposal.createdAt, r1.proposal.createdAt);
  assert.equal(listProposals(ctx.vault).length, 1);
  const r3 = createProposal(ctx.vault, { ...base, payload: { op: 'queue_teach', title: 'Z' } }, t0);
  assert.notEqual(r3.proposal.id, r1.proposal.id);
});

test('expireStale + decide respect TTL; expired duplicate is revived', () => {
  const ctx = testCtx();
  const t0 = new Date('2026-10-01T00:00:00Z');
  const { proposal } = createProposal(ctx.vault, sys, t0);
  assert.equal(expireStale(ctx.vault, new Date('2026-10-07T23:00:00Z')).length, 0);
  assert.equal(expireStale(ctx.vault, new Date('2026-10-08T00:00:01Z')).length, 1);
  assert.equal(getProposal(ctx.vault, proposal.id).status, 'expired');
  const late = decide(ctx.vault, proposal.id, 'approved', { now: new Date('2026-10-09T00:00:00Z') });
  assert.equal(late.changed, false);
  assert.equal(late.reason, 'not-pending');
  assert.equal(getProposal(ctx.vault, proposal.id).status, 'expired');
  const revived = createProposal(ctx.vault, sys, new Date('2026-10-10T00:00:00Z')).proposal;
  assert.equal(revived.status, 'pending');
  assert.equal(revived.id, proposal.id);
});

test('decide: approve/reject once, idempotent, cannot flip', () => {
  const ctx = testCtx();
  const { proposal } = createProposal(ctx.vault, base);
  const first = decide(ctx.vault, proposal.id, 'approved');
  assert.equal(first.proposal.status, 'approved');
  assert.equal(first.changed, true);
  assert.equal(decide(ctx.vault, proposal.id, 'approved').changed, false);
  const flip = decide(ctx.vault, proposal.id, 'rejected');
  assert.deepEqual([flip.changed, flip.ok, flip.reason], [false, false, 'not-pending']);
  assert.equal(getProposal(ctx.vault, proposal.id).status, 'approved');
  assert.throws(() => decide(ctx.vault, 'attic-nope', 'approved'), /찾지 못/);
});

test('decide refuses a pending proposal past its TTL', () => {
  const ctx = testCtx();
  const { proposal } = createProposal(ctx.vault, sys, new Date('2026-01-01T00:00:00Z'));
  const r = decide(ctx.vault, proposal.id, 'approved');
  assert.equal(r.reason, 'expired');
  assert.equal(r.ok, false);
  assert.equal(getProposal(ctx.vault, proposal.id).status, 'expired');
});

test('[6] decide uses createdAt + TTL even when expiresAt on disk was tampered with', () => {
  const ctx = testCtx();
  const t0 = new Date('2026-10-01T00:00:00Z');
  const { proposal } = createProposal(ctx.vault, sys, t0);
  const f = path.join(ctx.vault, '_attic/proposals', `${proposal.id}.json`);
  const j = JSON.parse(fs.readFileSync(f, 'utf8')); j.expiresAt = '2099-01-01T00:00:00.000Z'; fs.writeFileSync(f, JSON.stringify(j));
  const r = decide(ctx.vault, proposal.id, 'approved', { now: new Date('2026-10-20T00:00:00Z') });
  assert.equal(r.reason, 'expired');
  assert.equal(getProposal(ctx.vault, proposal.id).status, 'expired');
  assert.equal(expireStale(ctx.vault, t0).length, 0);
});

test('[6] decide records by/now; isApplicable needs approved AND decidedAt <= createdAt+TTL', () => {
  const ctx = testCtx();
  const t0 = new Date('2026-10-01T00:00:00Z');
  const { proposal } = createProposal(ctx.vault, base, t0);
  const r = decide(ctx.vault, proposal.id, 'approved', { by: 'tester', now: new Date('2026-10-02T00:00:00Z') });
  assert.equal(r.proposal.decidedBy, 'tester');
  assert.equal(isApplicable(r.proposal), true);
  assert.equal(isApplicable({ ...r.proposal, decidedAt: '2026-10-09T00:00:00Z' }), false);
  assert.equal(isApplicable({ ...r.proposal, decidedAt: undefined }), false);
  assert.equal(isApplicable({ ...r.proposal, status: 'pending' }), false);
});

test('[6] decide rejects ids that are not attic-<12 hex> (no path tricks)', () => {
  const ctx = testCtx();
  assert.throws(() => decide(ctx.vault, '../../x', 'approved'), /찾지 못|잘못된/);
});

test('summaryLines: 1..20 lines, no empties, <=300 chars', () => {
  const lines = summaryLines({ id: 'attic-x', summary: ['a', '', 'b\n\nc', 'x'.repeat(400), ...Array(30).fill('l')] });
  assert.ok(lines.length <= 20 && lines.every((l) => l && l.length <= 300));
  assert.deepEqual(summaryLines({ id: 'attic-x', summary: ['', ' '] }), ['attic-x']);
});
