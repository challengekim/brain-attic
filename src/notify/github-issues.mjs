// Two-way adapter using the `gh` CLI. Proposals become issues (label attic-proposal);
// a COMMENT saying approve/reject decides them; afterwards we label attic-applied and close.
// Who may decide: config.allowedUsers when that key is PRESENT (an explicit empty list = nobody can approve, and it
// revokes approvers stored earlier). Only when the key is ABSENT: the single login `gh api user` returned at publish
// time (stored in the proposal's local record). Labels are never
// consulted: GitHub does not tell us who applied a label.
import { run, which } from '../util.mjs';
import { decide, getProposal, listProposals, saveProposal } from '../proposals.mjs';

const KEY = 'github-issues';
const gh = (ctx, args, input) => run('gh', args, { env: ctx.env, timeoutMs: 60000, input });
function needGh(ctx, cfg) {
  if (!which('gh', ctx.env)) throw new Error('github-issues: gh CLI 가 없습니다');
  if (!cfg.repo) throw new Error('github-issues: config.repo (owner/name) 가 없습니다');
}
const decisionOf = (text) => {
  const t = String(text).trim().toLowerCase().replace(/^\/|[.!]+$/g, '');
  return t === 'approve' || t === 'approved' ? 'approved' : t === 'reject' || t === 'rejected' ? 'rejected' : null;
};

const hasAllowedKey = (cfg) => cfg.allowedUsers !== undefined;
function approversFor(cfg) {
  // Present but not a list (null, string, ...) fails closed: nobody.
  return Array.isArray(cfg.allowedUsers) ? cfg.allowedUsers.filter((u) => typeof u === 'string' && u.trim()).map((u) => u.trim().toLowerCase()) : [];
}

export async function publish(ctx, cfg, proposals) {
  needGh(ctx, cfg);
  let approvers = approversFor(cfg);
  if (!hasAllowedKey(cfg) && proposals.some((p) => !p.external?.[KEY]?.number)) {
    const me = await gh(ctx, ['api', 'user', '--jq', '.login']);
    const login = me.code === 0 ? me.stdout.trim().toLowerCase() : '';
    if (!/^[a-z0-9-]+(\[bot\])?$/.test(login)) throw new Error('github-issues: 승인자를 정할 수 없습니다 (gh api user 실패). config.allowedUsers 를 지정하거나 gh auth login 을 하세요');
    approvers = [login];
  }
  await gh(ctx, ['label', 'create', 'attic-proposal', '--repo', cfg.repo, '--force', '--color', 'BFD4F2']);
  await gh(ctx, ['label', 'create', 'attic-applied', '--repo', cfg.repo, '--force', '--color', '0E8A16']);
  let sent = 0;
  for (const p of proposals) {
    if (p.external?.[KEY]?.number) continue;
    const body = [p.summary.join('\n'), '', `id: \`${p.id}\` · kind: ${p.kind} · 만료: ${p.expiresAt.slice(0, 10)}`,
      '', '승인하려면 코멘트로 `approve`, 거절하려면 `reject` 라고 남기세요.'].join('\n');
    const r = await gh(ctx, ['issue', 'create', '--repo', cfg.repo, '--title', `[attic] ${p.summary[0].slice(0, 120)}`, '--body', body, '--label', 'attic-proposal']);
    if (r.code !== 0) throw new Error(`gh issue create 실패: ${r.stderr.trim().slice(0, 200)}`);
    const m = /\/issues\/(\d+)/.exec(r.stdout);
    if (!m) throw new Error('이슈 번호를 읽지 못했습니다');
    p.external = { ...p.external, [KEY]: { number: Number(m[1]), repo: cfg.repo, approvers } };
    saveProposal(ctx.vault, p);
    sent++;
  }
  return { ok: true, sent };
}

export async function pull(ctx, cfg) {
  needGh(ctx, cfg);
  const changed = [], closed = [];
  const fromConfig = approversFor(cfg);
  for (const p of listProposals(ctx.vault)) {
    const ref = p.external?.[KEY];
    if (!ref?.number || ref.repo !== cfg.repo || ref.done) continue; // only issues WE created for this repo
    // Current config wins, so emptying allowedUsers revokes stored approvers at once. Stored list only if the key is absent.
    const allowed = new Set(hasAllowedKey(cfg) ? fromConfig : (Array.isArray(ref.approvers) ? ref.approvers : []));
    const r = await gh(ctx, ['issue', 'view', String(ref.number), '--repo', cfg.repo, '--json', 'comments,state']);
    if (r.code !== 0) continue;
    let issue; try { issue = JSON.parse(r.stdout); } catch { continue; }
    let decision = null;
    for (const c of issue.comments || []) {
      const who = String(c.author?.login || '').toLowerCase();
      if (!who || !allowed.has(who)) continue; // empty approver list -> nobody passes
      decision = decisionOf(c.body) || decision; // latest allowed comment wins
    }
    if (decision) {
      const res = decide(ctx.vault, p.id, decision, { by: KEY });
      if (res.changed && res.reason !== 'expired') changed.push(p.id);
    }
    const fresh = getProposal(ctx.vault, p.id);
    if (fresh.status !== 'pending') {
      await gh(ctx, ['issue', 'edit', String(ref.number), '--repo', cfg.repo, '--add-label', 'attic-applied']);
      await gh(ctx, ['issue', 'close', String(ref.number), '--repo', cfg.repo]);
      fresh.external = { ...fresh.external, [KEY]: { ...ref, done: true } };
      closed.push(fresh.id);
      saveProposal(ctx.vault, fresh);
    }
  }
  return { ok: true, changed, closed };
}
