// attic apply: approved proposals only. Whitelisted ops edit config/files directly; everything else only
// produces a prompt file (_attic/approved/<id>.prompt.md) that a human can run through `claude -p`.
import fs from 'node:fs';
import { saveConfig } from './config.mjs';
import { requireVault } from './config.mjs';
import { atticPath, ensureSkeleton, writeAttic, writeAtticJson } from './vault.mjs';
import { isApplicable, listProposals, saveProposal } from './proposals.mjs';
import { readJson } from './util.mjs';
import { sourceName, sourceUrl } from './collect.mjs';

export const WHITELIST = ['add_source', 'remove_source', 'set_triage_budget', 'queue_teach'];

function validSource(s) {
  return s && typeof s === 'object' && ((typeof s.url === 'string' && /^https?:\/\//.test(s.url)) || (typeof s.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(s.repo)));
}

export function promptFor(p) {
  return [
    `# attic 제안 ${p.id} — 사람이 승인했고, 이 지시문은 아직 실행되지 않았습니다`, '',
    '아래 제안을 검토하고 필요한 변경을 **diff 로 먼저 보여준 뒤** 적용하세요. 사용자의 확인 없이 파일을 덮어쓰지 마세요.', '',
    '## 요약', ...p.summary.map((s) => `- ${s}`), '',
    '## 데이터', '```json', JSON.stringify(p.payload, null, 2), '```', '',
    p.payload?.prompt ? `## 추가 지시\n${p.payload.prompt}\n` : '',
    '실행 예: `claude -p < ' + `_attic/approved/${p.id}.prompt.md` + '`',
  ].join('\n');
}

export async function apply(ctx, { now = new Date() } = {}) {
  const vault = requireVault(ctx);
  ensureSkeleton(vault);
  const config = JSON.parse(JSON.stringify(ctx.config));
  const result = { applied: [], prompts: [], errors: [], skipped: [] };
  let configDirty = false;
  const awaitingConfig = []; // config ops: marked applied only AFTER the config file was saved
  for (const p of listProposals(vault, { status: 'approved' })) {
    // Only proposals approved within createdAt + TTL may act (an old/expired approval must not).
    if (!isApplicable(p)) { result.skipped.push({ id: p.id, reason: 'TTL 밖이거나 결정 시각이 없는 승인' }); continue; }
    const op = p.payload?.op;
    try {
      if (op === 'add_source') {
        if (!validSource(p.payload.source)) throw new Error('source 가 올바르지 않습니다 (url 또는 repo 필요)');
        const key = sourceUrl(p.payload.source);
        if (!config.sources.some((s) => sourceUrl(s) === key)) { config.sources.push(p.payload.source); configDirty = true; }
        awaitingConfig.push({ p, op });
      } else if (op === 'remove_source') {
        const m = p.payload.match;
        if (typeof m !== 'string' || !m) throw new Error('match 가 없습니다');
        const before = config.sources.length;
        config.sources = config.sources.filter((s) => ![sourceName(s), s.url, s.repo].includes(m));
        if (config.sources.length !== before) configDirty = true;
        awaitingConfig.push({ p, op });
      } else if (op === 'set_triage_budget') {
        const w = Number(p.payload.weeklyMinutes);
        if (!Number.isInteger(w) || w < 0 || w > 3000) throw new Error('weeklyMinutes 는 0..3000 정수여야 합니다');
        config.triage = { ...config.triage, weeklyMinutes: w }; configDirty = true;
        awaitingConfig.push({ p, op });
      } else if (op === 'queue_teach') {
        const q = readJson(atticPath(vault, 'teach', 'queue.json'), []);
        if (!q.some((x) => x.proposalId === p.id)) q.push({ proposalId: p.id, title: p.payload.title, url: p.payload.url || '', project: p.payload.project || null, minutes: p.payload.minutes || null, queuedAt: now.toISOString() });
        writeAtticJson(vault, 'teach/queue.json', q);
        p.status = 'applied'; p.appliedAt = now.toISOString(); saveProposal(vault, p);
        result.applied.push({ id: p.id, op });
      } else {
        const rel = `approved/${p.id}.prompt.md`;
        if (!fs.existsSync(atticPath(vault, rel))) writeAttic(vault, rel, promptFor(p));
        p.promptFile = rel; saveProposal(vault, p);
        result.prompts.push({ id: p.id, file: atticPath(vault, rel) });
      }
    } catch (e) { result.errors.push({ id: p.id, error: e.message }); }
  }
  // Save the config FIRST; only then record "applied". A failed save leaves them approved so the next run retries.
  let saved = true;
  if (configDirty) {
    try { saveConfig(config, ctx.env, ctx.configPath); }
    catch (e) { saved = false; for (const { p } of awaitingConfig) result.errors.push({ id: p.id, error: `설정 저장 실패: ${e.message}` }); }
  }
  if (saved) {
    for (const { p, op } of awaitingConfig) {
      try {
        p.status = 'applied'; p.appliedAt = now.toISOString(); saveProposal(vault, p);
        result.applied.push({ id: p.id, op });
      } catch (e) { result.errors.push({ id: p.id, error: e.message }); }
    }
  }
  return result;
}
