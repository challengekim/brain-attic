import { adapters } from './simple.mjs';
import * as decisionApi from './decision-api.mjs';
import * as githubIssues from './github-issues.mjs';

export const twoWay = { 'decision-api': decisionApi, 'github-issues': githubIssues };

/** Send a message to every configured notifier; two-way ones also publish the proposals. Never throws. */
export async function dispatch(ctx, msg, proposals = []) {
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
