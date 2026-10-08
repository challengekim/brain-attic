// Proposal store: <vault>/_attic/proposals/<id>.json. id = attic- + first 12 hex of sha256(instanceId + content).
// The per-vault instanceId (random, _attic/state/instance.json) keeps ids from colliding with other vaults' proposals.
import fs from 'node:fs';
import path from 'node:path';
import { atticPath, ensureSkeleton, getInstanceId, writeAtticJson } from './vault.mjs';
import { readJson, sha256, stableStringify } from './util.mjs';

export const TTL_DAYS = 7;
export const STATUSES = ['pending', 'approved', 'rejected', 'expired', 'applied'];

export function proposalId(vault, { kind, summary, payload }) {
  return 'attic-' + sha256(getInstanceId(vault) + stableStringify({ kind, summary, payload })).slice(0, 12);
}
const ID_RE = /^attic-[0-9a-f]{12}$/;
const rel = (id) => {
  if (!ID_RE.test(String(id))) throw new Error(`잘못된 제안 id: ${id}`);
  return `proposals/${id}.json`;
};
const file = (vault, id) => atticPath(vault, rel(id));
const deadline = (p) => new Date(p.createdAt).getTime() + TTL_DAYS * 86400000;

/** Same content -> same id (idempotent). An expired duplicate is revived as pending. */
export function createProposal(vault, { kind, summary, payload, source = 'review' }, now = new Date()) {
  ensureSkeleton(vault);
  const lines = (Array.isArray(summary) ? summary : String(summary).split('\n')).map((s) => String(s).trim()).filter(Boolean);
  const id = proposalId(vault, { kind, summary: lines, payload });
  const existing = readJson(file(vault, id), null);
  if (existing && existing.status !== 'expired') return { proposal: existing, created: false };
  const p = {
    id, kind, summary: lines, payload, source, status: 'pending',
    // A revived (previously expired) proposal is a new generation: answers given to an older
    // generation must not approve this one (see notify/decision-api.mjs).
    generation: existing ? (existing.generation || 1) + 1 : 1,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + TTL_DAYS * 86400000).toISOString(),
    external: {},
  };
  saveProposal(vault, p);
  return { proposal: p, created: !existing };
}

export function getProposal(vault, id) { return ID_RE.test(String(id)) ? readJson(file(vault, id), null) : null; }
export function saveProposal(vault, p) { writeAtticJson(vault, rel(p.id), p); return p; }

export function listProposals(vault, { status } = {}) {
  const dir = atticPath(vault, 'proposals');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const all = names.map((n) => readJson(path.join(dir, n), null)).filter(Boolean);
  return (status ? all.filter((p) => p.status === status) : all).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** Mark pending proposals past createdAt + TTL as expired. Returns the ones changed. */
export function expireStale(vault, now = new Date()) {
  const changed = [];
  for (const p of listProposals(vault, { status: 'pending' })) {
    if (deadline(p) <= now.getTime()) { p.status = 'expired'; p.expiredAt = now.toISOString(); saveProposal(vault, p); changed.push(p); }
  }
  return changed;
}

/**
 * The ONLY place a proposal goes pending -> approved|rejected (CLI and every sync adapter use it).
 * Never throws for "cannot decide": returns { ok, changed, reason?, proposal }.
 *   reason: 'not-pending' (already decided/expired/applied; unchanged), 'expired' (TTL passed: marked expired, NOT approved).
 * Throws only for a bad status argument or an unknown id.
 */
export function decide(vault, id, status, { by = 'cli', now = new Date() } = {}) {
  if (!['approved', 'rejected'].includes(status)) throw new Error(`잘못된 상태: ${status}`);
  const p = getProposal(vault, id);
  if (!p) throw new Error(`제안을 찾지 못했습니다: ${id}`);
  if (p.status !== 'pending') return { ok: p.status === status, changed: false, reason: 'not-pending', proposal: p };
  if (deadline(p) <= now.getTime()) {
    p.status = 'expired'; p.expiredAt = now.toISOString(); saveProposal(vault, p);
    return { ok: false, changed: true, reason: 'expired', proposal: p };
  }
  p.status = status; p.decidedAt = now.toISOString(); p.decidedBy = by;
  saveProposal(vault, p);
  return { ok: true, changed: true, proposal: p };
}

/** apply() may only act on approved proposals that were approved within their TTL window. */
export function isApplicable(p) {
  if (!p || p.status !== 'approved') return false;
  const at = Date.parse(p.decidedAt);
  return Number.isFinite(at) && at <= deadline(p);
}

/** Summary lines for transports that limit them: 1..20 non-empty lines, each <= 300 chars. */
export function summaryLines(p) {
  const lines = p.summary.flatMap((s) => String(s).split('\n')).map((s) => s.trim()).filter(Boolean)
    .map((s) => (s.length > 300 ? s.slice(0, 299) + '…' : s));
  const out = lines.slice(0, 20);
  return out.length ? out : [p.id];
}
