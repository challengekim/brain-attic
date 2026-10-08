import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCtx, routeFetch, ROOT } from './helpers.mjs';
import * as or from '../src/sources/openrouter.mjs';
import * as kie from '../src/sources/kie.mjs';
import { radar, recentEvents } from '../src/radar.mjs';
import { atticPath } from '../src/vault.mjs';

const fxText = (n) => fs.readFileSync(path.join(ROOT, 'test/fixtures', n), 'utf8');
const snap = (n) => or.toSnapshot(JSON.parse(fxText(n)));

test('openrouter diff: new models, price +-20%, new output modality; ignores small changes and negative prices', () => {
  const d = or.diffSnapshots(snap('or-a.json'), snap('or-b.json'));
  assert.deepEqual(d.added.map((m) => m.id).sort(), ['v/new-image', 'v/new-text']);
  assert.deepEqual(d.added.find((m) => m.id === 'v/new-image').nonText, ['image']);
  assert.deepEqual(d.priceChanges.map((c) => `${c.id}:${c.field}`), ['v/cheap:prompt']); // completion -5% and v/stable +10% are below threshold
  assert.ok(d.priceChanges[0].change < -0.4);
  assert.deepEqual(d.newModalities, [{ id: 'v/gains', name: 'V: Gains', gained: ['image'] }]);
});

test('kie llms.txt: parses category > name, skips translated duplicates, diffs new docs', () => {
  const a = kie.toSnapshot(fxText('kie-a.txt')), b = kie.toSnapshot(fxText('kie-b.txt'));
  assert.equal(a.count, 3);
  assert.equal(a.docs['https://docs.kie.ai/veo3-api/video.md'].category, 'Video Models > Veo3.1 API');
  const d = kie.diffSnapshots(a, b);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].title, 'Seedance Video Generation');
  assert.deepEqual(kie.capabilitiesOf('Video Models > Seedance 2 API'), ['video']);
});

test('radar: first run = baseline only, second run reports diff and records events', async () => {
  let phase = 'a';
  const ctx = testCtx();
  ctx.fetch = routeFetch({
    'openrouter.ai': () => fxText(phase === 'a' ? 'or-a.json' : 'or-b.json'),
    'docs.kie.ai': () => fxText(phase === 'a' ? 'kie-a.txt' : 'kie-b.txt'),
  });
  const r1 = await radar(ctx, { now: new Date('2026-10-07T09:10:00') });
  assert.deepEqual(r1.results.map((r) => r.status), ['baseline', 'baseline']);
  assert.deepEqual(recentEvents(ctx.vault, 7, new Date('2026-10-08')), []);
  phase = 'b';
  const r2 = await radar(ctx, { now: new Date('2026-10-08T09:10:00') });
  assert.deepEqual(r2.results.map((r) => r.status), ['diff', 'diff']);
  const ev = recentEvents(ctx.vault, 7, new Date('2026-10-08T12:00:00'));
  const kinds = ev.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['kie_new', 'modality', 'new', 'new', 'price_drop']);
  const report = fs.readFileSync(r2.file, 'utf8');
  assert.match(report, /신규: `v\/new-image`/);
  assert.match(report, /새 출력 image/);
  // third run: nothing new, events not duplicated
  const r3 = await radar(ctx, { now: new Date('2026-10-08T10:00:00') });
  assert.deepEqual(r3.results.map((r) => r.diff && (r.diff.added?.length ?? 0)), [0, 0]);
  assert.equal(recentEvents(ctx.vault, 7, new Date('2026-10-08T12:00:00')).length, 5);
});

test('radar: network failure is reported as skipped and keeps the old snapshot', async () => {
  const ctx = testCtx();
  ctx.fetch = routeFetch({ 'openrouter.ai': () => fxText('or-a.json'), 'docs.kie.ai': () => fxText('kie-a.txt') });
  await radar(ctx);
  const file = atticPath(ctx.vault, 'radar', 'openrouter-latest.json');
  const before = fs.readFileSync(file, 'utf8');
  ctx.fetch = routeFetch({ 'openrouter.ai': new Error('offline'), 'docs.kie.ai': () => new Response('x', { status: 503 }) });
  const r = await radar(ctx);
  assert.deepEqual(r.results.map((x) => x.status), ['skipped', 'skipped']);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.match(fs.readFileSync(r.file, 'utf8'), /건너뜀/);
});
