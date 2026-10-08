// Two-way adapter for an app exposing /api/agent-decisions/sync (e.g. the author's LCC app).
//   POST  {changeId, kind, summary:[<=300 chars x 1..20], payload, reclassify?}    (Bearer token)
//         reclassify = {options:[{value,label}], current} only on classification proposals (c/b/d ops):
//         the app shows a "change class" picker and never interprets payload itself.
//   GET   ?kind=<kind>  -> answers [{changeId, kind, payload, approved, reclassifyTo?, answeredAt, createdAt}]
//         reclassifyTo (a|b|c|d) = the user picked that class on the card: handled exactly like `attic reclassify`.
//         (accepts {data:{answers}}, {ok:true,data:{answers}} or {answers})
//   PATCH {changeIds:[...], kind}  -> ack. ONLY ids that exist in OUR local store AND were published by THIS adapter
//   (external['decision-api'].sentAt) are accepted/acked; every other id is ignored and left alone.
import { decide, getProposal, isAutoApplicable, reclassify, saveProposal, summaryLines } from '../proposals.mjs';
import { http, needSecret } from './http.mjs';

const endpoint = (cfg) => `${String(cfg.baseUrl).replace(/\/+$/, '')}/api/agent-decisions/sync`;
const kindOf = (cfg) => cfg.kind || 'knowledge';
const auth = (ctx, cfg) => ({ authorization: `Bearer ${needSecret(ctx, cfg, 'tokenEnv', 'decision-api')}` });

export function unwrapAnswers(body) {
  let d = body;
  for (let i = 0; i < 4 && d && typeof d === 'object' && !Array.isArray(d.answers) && d.data; i++) d = d.data;
  return Array.isArray(d?.answers) ? d.answers : [];
}

export async function publish(ctx, cfg, proposals) {
  const headers = auth(ctx, cfg);
  let sent = 0;
  for (const p of proposals) {
    if (p.external?.['decision-api']?.sentAt) continue; // already sent: same id is idempotent anyway
    const changeId = changeIdOf(p);
    const offer = reclassifyOffer(p);
    await http(ctx, endpoint(cfg), { method: 'POST', headers, json: { changeId, kind: kindOf(cfg), summary: summaryLines(p), payload: { ...p.payload, proposalKind: p.kind }, ...(offer ? { reclassify: offer } : {}) } });
    p.external = { ...p.external, 'decision-api': { sentAt: new Date().toISOString(), changeId } };
    saveProposal(ctx.vault, p);
    sent++;
  }
  return { ok: true, sent };
}

const OP_CLASS = { queue_teach: 'c', note_auto: 'b', archive_note: 'd' };
const CLASS_LABEL = { a: 'a 인지만', b: 'b 자동 반영', c: 'c 설명하기', d: 'd 보관' };

/**
 * The "change class" options the card may offer. Only classification proposals get one; d (archive) only for vault
 * notes, because `reclassify` refuses d without a file. Labels are ours, the app just renders them.
 */
export function reclassifyOffer(p) {
  if (!isAutoApplicable(p)) return null;
  const current = OP_CLASS[p.payload.op];
  const values = ['a', 'b', 'c', ...(p.payload.file ? ['d'] : [])];
  if (!values.includes(current)) values.push(current);
  return { options: values.map((value) => ({ value, label: CLASS_LABEL[value] })), current };
}

/** Remote id: the proposal id, plus the generation for revived proposals, so an old answer cannot match. */
export function changeIdOf(p) { return (p.generation || 1) > 1 ? `${p.id}-g${p.generation}` : p.id; }
const baseIdOf = (changeId) => changeId.replace(/-g\d+$/, '');

export async function pull(ctx, cfg) {
  const kind = kindOf(cfg);
  const headers = auth(ctx, cfg);
  const res = await http(ctx, `${endpoint(cfg)}?kind=${encodeURIComponent(kind)}`, { method: 'GET', headers });
  const answers = unwrapAnswers(res.data);
  const changed = [], ackIds = [], ignored = [];
  for (const a of answers) {
    if (!a || typeof a.changeId !== 'string') continue;
    if (a.kind && a.kind !== kind) { ignored.push(a.changeId); continue; }
    const p = getProposal(ctx.vault, baseIdOf(a.changeId));
    const sent = p?.external?.['decision-api'];
    // Not ours (unknown locally, or never published through this adapter): leave it alone, do not ack.
    if (!p || !sent?.sentAt) { ignored.push(a.changeId); continue; }
    // Ours but for another generation, or answered before this generation was sent: stale.
    // Ack it so the app stops re-sending, but never apply it.
    const current = (sent.changeId || p.id) === a.changeId;
    const answeredAt = a.answeredAt ? Date.parse(a.answeredAt) : NaN;
    if (!current || (Number.isFinite(answeredAt) && answeredAt < Date.parse(sent.sentAt))) {
      ignored.push(a.changeId); ackIds.push(a.changeId); continue;
    }
    if (p.status === 'pending' && a.approved === true && typeof a.reclassifyTo === 'string') {
      // The user picked a class on the card: their instruction beats the recommendation (same as `attic reclassify`).
      // The decision was made at answeredAt (inside the card's TTL), so judge the deadline at that moment, not at pull time.
      const cls = a.reclassifyTo.toLowerCase();
      const at = Number.isFinite(answeredAt) && answeredAt <= Date.now() ? new Date(answeredAt) : new Date();
      try {
        const q = reclassify(ctx.vault, p.id, cls, { by: 'decision-api', now: at });
        if (q.status === 'pending') decide(ctx.vault, p.id, 'approved', { by: 'decision-api', now: at });
        // reclassify() drops remote references (new generation). The answer is already final here, so keep our send
        // record: if the PATCH below fails, the next pull still recognises this changeId as ours and retries the ack.
        const done = getProposal(ctx.vault, p.id);
        if (!done.external?.['decision-api']) { done.external = { ...done.external, 'decision-api': { ...sent, reclassifiedTo: cls } }; saveProposal(ctx.vault, done); }
        changed.push(p.id);
      } catch (e) {
        // Not applicable (unknown class, d without a file, not a classification proposal, TTL passed): leave the
        // proposal alone so its normal rule applies, but ack so the app stops re-sending an answer we cannot use.
        ignored.push(a.changeId);
        ctx.log?.warn?.(`decision-api: ${p.id} 분류 바꾸기(${cls})를 적용하지 못했습니다 — ${e.message}`);
      }
      ackIds.push(a.changeId);
      continue;
    }
    if (p.status === 'pending' && typeof a.approved === 'boolean') {
      const r = decide(ctx.vault, p.id, a.approved ? 'approved' : 'rejected', { by: 'decision-api' });
      if (r.changed && r.reason !== 'expired') changed.push(p.id);
    }
    ackIds.push(a.changeId);
  }
  if (ackIds.length) await http(ctx, endpoint(cfg), { method: 'PATCH', headers, json: { changeIds: ackIds, kind } });
  return { ok: true, changed, acked: ackIds, ignored };
}
