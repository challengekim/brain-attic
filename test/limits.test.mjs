import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collect } from '../src/collect.mjs';
import { triage } from '../src/triage.mjs';

function rss(n, daysAgoOf) {
  const now = Date.now();
  const items = Array.from({ length: n }, (_, i) =>
    `<item><title>t${i}</title><link>https://ex.com/p${i}</link><pubDate>${new Date(now - daysAgoOf(i) * 86400000).toUTCString()}</pubDate></item>`).join('');
  return `<?xml version="1.0"?><rss><channel>${items}</channel></rss>`;
}

function ctxFor(vault, config, fetchBody) {
  return {
    env: { ...process.env }, home: vault, vault,
    config: { sources: [{ type: 'rss', name: 'feed', url: 'https://ex.com/rss' }], llm: { runner: 'none' }, triage: { include: [] }, ...config },
    log: { info() {}, warn() {} },
    fetch: async () => new Response(fetchBody, { status: 200 }),
  };
}

test('first collect only takes recent items and caps per source; old items do not return', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-lim-'));
  const body = rss(60, (i) => i); // item i is i days old
  const ctx = ctxFor(vault, {}, body);
  const r1 = await collect(ctx);
  assert.ok(r1.added >= 7 && r1.added <= 8, `only the last 7 days (got ${r1.added})`);
  const r2 = await collect(ctxFor(vault, {}, body));
  assert.equal(r2.added, 0, 'skipped old items are remembered as seen');
});

test('later runs cap per source', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-lim-'));
  fs.mkdirSync(path.join(vault, '_attic', 'state'), { recursive: true });
  fs.writeFileSync(path.join(vault, '_attic', 'state', 'seen.json'), JSON.stringify({ 'https://old.example': new Date().toISOString().slice(0, 10) }));
  const r = await collect(ctxFor(vault, { collect: { maxPerSource: 5 } }, rss(30, () => 0)));
  assert.equal(r.added, 5);
  assert.equal(r.skipped, 25);
});

test('triage sends at most maxItems to the runner and marks the rest', async () => {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-lim-'));
  const ctx = ctxFor(vault, { collect: { maxPerSource: 100, firstRunDays: 30 }, triage: { include: [], maxItems: 10 } }, rss(25, () => 0));
  await collect(ctx);
  const out = await triage(ctx);
  assert.equal(out.items.length, 25);
  assert.equal(out.overflow, 15);
  assert.equal(out.items.filter((i) => /상한/.test(i.reason)).length, 15);
});
