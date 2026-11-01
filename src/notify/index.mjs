import { adapters } from './simple.mjs';
import * as decisionApi from './decision-api.mjs';
import * as githubIssues from './github-issues.mjs';
import { listProposals, saveProposal } from '../proposals.mjs';

export const twoWay = { 'decision-api': decisionApi, 'github-issues': githubIssues };

/** Send a message to every configured notifier; two-way ones also publish the proposals. Never throws. */
export async function dispatch(ctx, msg, proposals = []) {
  // Remember that these cards were offered to the user. If a two-way adapter cannot publish them now (app down, offline),
  // `resendUnsent` (hourly tick) sends them later instead of waiting for the next weekly review.
  if (ctx.vault && proposals.length) {
    const at = new Date().toISOString();
    for (const p of proposals) if (!p.offeredAt) { p.offeredAt = at; saveProposal(ctx.vault, p); }
  }
  const results = [];
  for (const cfg of ctx.config.notifiers || []) {
    const type = cfg.type;
    try {
      if (twoWay[type]) { results.push({ type, ...(await twoWay[type].publish(ctx, cfg, proposals)) }); }
      else if (adapters[type]) results.push({ type, ...(await adapters[type](ctx, cfg, msg)) });
      else results.push({ type, ok: false, error: `알 수 없는 notifier: ${type}` });
    } catch (e) { results.push({ type, ok: false, error: e.message }); ctx.log.warn(`알림 실패 (${type}): ${e.message}`); }
  }
  return results;
}

export async function syncAll(ctx) {
  const out = [];
  for (const cfg of ctx.config.notifiers || []) {
    const a = twoWay[cfg.type];
    if (!a) continue;
    try { out.push({ type: cfg.type, ...(await a.pull(ctx, cfg)) }); }
    catch (e) { out.push({ type: cfg.type, ok: false, error: e.message }); ctx.log.warn(`sync 실패 (${cfg.type}): ${e.message}`); }
  }
  return out;
}

/**
 * Hourly retry: pending proposals that were offered (passed to `dispatch`) but that a two-way adapter has not published yet.
 * Only offered ones, so a card a review run is still building or deduplicating is never sent early. The CLI runs it
 * under the vault run lock (src/runlock.mjs), so it never overlaps a review, retro or another tick. Never throws.
 */
export async function resendUnsent(ctx, now = new Date()) {
  const offered = listProposals(ctx.vault, { status: 'pending' })
    .filter((p) => p.offeredAt && !(Date.parse(p.expiresAt) <= now.getTime()));
  const out = [];
  for (const cfg of ctx.config.notifiers || []) {
    const a = twoWay[cfg.type];
    if (!a) continue;
    const unsent = offered.filter((p) => !a.isPublished(p));
    if (!unsent.length) continue;
    try { out.push({ type: cfg.type, ...(await a.publish(ctx, cfg, unsent)) }); }
    catch (e) { out.push({ type: cfg.type, ok: false, error: e.message }); ctx.log.warn(`재발송 실패 (${cfg.type}): ${e.message}`); }
  }
  return out;
}
