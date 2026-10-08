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
/**
 * Classification proposals (the weekly a/b/c/d suggestions): c -> queue_teach, b -> note_auto, d -> archive_note.
 * With no answer after the TTL these are applied as recommended (marked autoApplied). Anything that changes the system
 * (add/remove source, criteria, re-review, improvements) is NOT in this set and still expires.
 */
export const AUTO_OPS = ['queue_teach', 'note_auto', 'archive_note'];
export const isAutoApplicable = (p) => AUTO_OPS.includes(p?.payload?.op);
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

/** Past the TTL with no answer: approve a classification proposal as recommended (decidedAt = the deadline, so it stays inside the TTL window). */
function autoApprove(vault, p, now, by = 'auto') {
  p.status = 'approved'; p.decidedAt = new Date(deadline(p)).toISOString(); p.decidedBy = by; p.autoApplied = true; p.autoApprovedAt = now.toISOString();
  saveProposal(vault, p);
  return p;
}

/**
 * Pending proposals past createdAt + TTL: classification proposals are auto-approved (autoApplied: true, applied by
 * `attic apply`), everything else is marked expired. Returns the ones changed (check .status).
 */
export function expireStale(vault, now = new Date()) {
  const changed = [];
  for (const p of listProposals(vault, { status: 'pending' })) {
    if (deadline(p) > now.getTime()) continue;
    if (isAutoApplicable(p)) { autoApprove(vault, p, now); changed.push(p); continue; }
    p.status = 'expired'; p.expiredAt = now.toISOString(); saveProposal(vault, p); changed.push(p);
  }
  return changed;
}

/**
 * The user changes the class of a pending classification proposal (their instruction beats the recommendation).
 * a -> nothing to do: the proposal is closed as rejected with reclassifiedTo 'a' (just be aware).
 * b/c/d -> the proposal is rewritten in place to that class's op, keeping the original in `recommended`.
 */
export function reclassify(vault, id, cls, { by = 'cli', now = new Date() } = {}) {
  if (!['a', 'b', 'c', 'd'].includes(cls)) throw new Error(`분류는 a/b/c/d 중 하나여야 합니다: ${cls}`);
  const p = getProposal(vault, id);
  if (!p) throw new Error(`제안을 찾지 못했습니다: ${id}`);
  if (p.status !== 'pending') throw new Error(`${id}: 이미 ${p.status} 상태라 분류를 바꿀 수 없습니다`);
  if (!isAutoApplicable(p)) throw new Error(`${id}: 분류 제안이 아닙니다 (${p.payload?.op})`);
  if (deadline(p) <= now.getTime()) throw new Error(`${id}: TTL 이 지났습니다 — attic pending 으로 상태를 먼저 확인하세요`);
  const cur = p.payload;
  const was = { queue_teach: 'c', note_auto: 'b', archive_note: 'd' }[cur.op];
  p.recommended = p.recommended || { class: was, op: cur.op, kind: p.kind, payload: cur, summary: p.summary };
  p.userClass = cls; p.reclassifiedAt = now.toISOString(); p.reclassifiedBy = by;
  if (cls === was) return p;
  if (cls === 'a') {
    p.status = 'rejected'; p.decidedAt = now.toISOString(); p.decidedBy = by; p.reclassifiedTo = 'a';
    return saveProposal(vault, p);
  }
  const base = { title: cur.title, url: cur.url || '', kind: cur.kind, ...(cur.file ? { file: cur.file } : {}), project: cur.project || null };
  if (cls === 'c') { p.kind = 'teach'; p.payload = { op: 'queue_teach', ...base, minutes: cur.minutes || 30 }; }
  else if (cls === 'b') { p.kind = 'auto'; p.payload = { op: 'note_auto', ...base }; }
  else {
    if (!cur.file) throw new Error(`${id}: d(보관) 는 볼트 노트에만 쓸 수 있습니다`);
    p.kind = 'drop'; p.payload = { op: 'archive_note', title: cur.title, file: cur.file, kind: 'vault' };
  }
  p.summary = [`(분류를 ${was} -> ${cls} 로 바꿈) ${cur.title}`, ...p.summary.slice(1)];
  return saveProposal(vault, p);
}

/**
 * The ONLY place a proposal goes pending -> approved|rejected (CLI and every sync adapter use it).
 * Never throws for "cannot decide": returns { ok, changed, reason?, proposal }.
 *   reason: 'not-pending' (already decided/expired/applied; unchanged), 'expired' (TTL passed: marked expired, NOT approved),
 *   'auto-applied' (TTL passed on a classification proposal: approved as recommended, autoApplied).
 * Throws only for a bad status argument or an unknown id.
 */
export function decide(vault, id, status, { by = 'cli', now = new Date() } = {}) {
  if (!['approved', 'rejected'].includes(status)) throw new Error(`잘못된 상태: ${status}`);
  const p = getProposal(vault, id);
  if (!p) throw new Error(`제안을 찾지 못했습니다: ${id}`);
  if (p.status !== 'pending') return { ok: p.status === status, changed: false, reason: 'not-pending', proposal: p };
  if (deadline(p) <= now.getTime()) {
    // A late answer on a classification proposal: "approve" applies it as recommended (or as the user's class),
    // "reject" is an explicit instruction and wins over the automatic rule.
    if (isAutoApplicable(p)) {
      if (status === 'approved') { autoApprove(vault, p, now, by); return { ok: true, changed: true, reason: 'auto-applied', proposal: p }; }
      p.status = 'rejected'; p.decidedAt = now.toISOString(); p.decidedBy = by; saveProposal(vault, p);
      return { ok: true, changed: true, proposal: p };
    }
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
