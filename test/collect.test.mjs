import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCtx, routeFetch, ROOT } from './helpers.mjs';
import { parseFeed } from '../src/sources/feed.mjs';
import { collect, parseInbox, sourceUrl } from '../src/collect.mjs';
import { normalizeUrl } from '../src/util.mjs';
import { ensureSkeleton, atticPath } from '../src/vault.mjs';

const fx = (n) => fs.readFileSync(path.join(ROOT, 'test/fixtures', n), 'utf8');

test('parseFeed: RSS (CDATA, entities, missing link skipped)', () => {
  const items = parseFeed(fx('sample.rss'));
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Hello & World');
  assert.equal(items[0].url, 'https://example.com/post-1/?utm_source=x&id=7');
  assert.equal(items[0].summary, 'First & best');
  assert.equal(items[1].summary, 'Plain text');
});

test('parseFeed: Atom (rel=alternate preferred, content, published/updated)', () => {
  const items = parseFeed(fx('sample.atom'));
  assert.equal(items.length, 2);
  assert.equal(items[0].url, 'https://github.com/o/r/releases/tag/v1.2.0');
  assert.equal(items[0].summary, 'fix');
  assert.equal(items[0].published, '2026-10-06T00:00:00Z');
  assert.equal(items[1].url, 'https://github.com/o/r/releases/tag/v1.1.0/');
});

test('normalizeUrl strips utm, fragment and trailing slash', () => {
  assert.equal(normalizeUrl('https://Example.com/a/b/?utm_source=x&id=7#frag'), 'https://example.com/a/b?id=7');
  assert.equal(normalizeUrl('https://example.com/?utm_medium=y'), 'https://example.com');
  assert.equal(normalizeUrl('https://example.com/a?fbclid=1'), 'https://example.com/a');
});

test('github source maps to releases.atom', () => {
  assert.equal(sourceUrl({ type: 'github', repo: 'o/r' }), 'https://github.com/o/r/releases.atom');
});

test('collect: dedupes within and across runs, writes inbox, survives a failing source', async () => {
  const ctx = testCtx({ config: { sources: [
    { type: 'rss', name: 'S1', url: 'https://a.test/feed' },
    { type: 'github', repo: 'o/r' },
    { type: 'rss', name: 'Broken', url: 'https://broken.test/feed' },
  ] } });
  ctx.fetch = routeFetch({ 'a.test': fx('sample.rss'), 'github.com/o/r': fx('sample.atom'), 'broken.test': new Error('dns') });
  const now = new Date('2026-10-07T09:00:00');
  const r1 = await collect(ctx, { now });
  assert.equal(r1.added, 4);
  assert.equal(r1.errors.length, 1);
  const inbox = fs.readFileSync(atticPath(ctx.vault, 'inbox', '2026-10-07.md'), 'utf8');
  const parsed = parseInbox(inbox, '2026-10-07');
  assert.equal(parsed.length, 4);
  assert.ok(parsed.every((p) => !p.url.includes('utm_')));
  assert.ok(parsed.some((p) => p.source === 'S1' && p.title === 'Hello & World'));
  const r2 = await collect(ctx, { now });
  assert.equal(r2.added, 0);
  assert.equal(r2.duplicates, 4);
});

test('collect: ledger forgets entries older than 60 days', async () => {
  const ctx = testCtx({ config: { sources: [{ type: 'rss', name: 'S1', url: 'https://a.test/feed' }] } });
  ensureSkeleton(ctx.vault);
  fs.writeFileSync(atticPath(ctx.vault, 'state', 'seen.json'), JSON.stringify({
    'https://example.com/post-1?id=7': '2026-07-01',   // 98 days old -> forgotten
    'https://example.com/post-2': '2026-10-01',        // fresh -> still deduped
  }));
  ctx.fetch = routeFetch({ 'a.test': fx('sample.rss') });
  const r = await collect(ctx, { now: new Date('2026-10-07T09:00:00') });
  assert.equal(r.added, 1);
  assert.equal(r.duplicates, 1);
});
