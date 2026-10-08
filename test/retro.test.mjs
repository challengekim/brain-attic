import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { testCtx } from './helpers.mjs';
import { compute, descriptorsFrom, retro, previousMonth } from '../src/retro.mjs';
import { atticPath, ensureSkeleton, stringifyFrontmatter } from '../src/vault.mjs';
import { writeJson } from '../src/util.mjs';

const item = (source, cls) => ({ id: 'i', title: 't', url: '', source, class: cls });
const tri = (iso, items) => ({ week: 'w', generatedAt: iso, items });
const prop = (kind, status, createdAt = '2026-09-10T00:00:00Z') => ({ id: `attic-${Math.random()}`, kind, status, createdAt });

const triages = [
  tri('2026-06-15T00:00:00Z', [item('Quiet', 'b'), item('Noisy', 'a')]),            // gives >= 90 days of history
  tri('2026-09-02T00:00:00Z', [item('Noisy', 'a'), item('Noisy', 'c'), item('Quiet', 'b'), item('Quiet', 'unclassified')]),
  tri('2026-09-09T00:00:00Z', [item('Noisy', 'b'), item('Quiet', 'b')]),
];

test('compute: per-source counts, ratios, approval rate, teach average, silent sources (90d)', () => {
  const r = compute({
    triages,
    proposals: [prop('teach', 'approved'), prop('teach', 'applied'), prop('teach', 'rejected'), prop('improve', 'rejected'), prop('improve', 'expired'), prop('improve', 'rejected'), prop('improve', 'approved'), prop('improve', 'pending'), prop('teach', 'approved', '2026-08-01T00:00:00Z')],
    teachNotes: [{ score: 80 }, { score: 60 }, {}],
    sourcesConfigured: ['Noisy', 'Quiet', 'Never'],
    month: '2026-09',
  });
  assert.deepEqual(r.perSource.Noisy, { total: 3, a: 1, b: 1, c: 1, d: 0, unclassified: 0 });
  assert.deepEqual(r.perSource.Quiet, { total: 3, a: 0, b: 2, c: 0, d: 0, unclassified: 1 });
  assert.equal(r.counts.b, 3);
  assert.ok(Math.abs(r.ratios.a - 1 / 6) < 1e-9);
  assert.equal(r.approval.byKind.teach.rate, 2 / 3);
  assert.equal(r.approval.byKind.improve.decided, 4);
  assert.equal(r.approval.byKind.improve.rate, 0.25);
  assert.equal(r.approval.overall, 3 / 7);
  assert.deepEqual(r.teach, { count: 3, avgScore: 70 });
  assert.equal(r.coverageOk, true);
  assert.deepEqual(r.silent.map((s) => s.source).sort(), ['Never', 'Quiet']);
  const d = descriptorsFrom(r);
  assert.ok(d.some((x) => x.payload.op === 'remove_source' && x.payload.match === 'Quiet'));
  assert.ok(d.some((x) => x.payload.op === 'adjust_criteria' && x.payload.category === 'improve'));
  assert.ok(!d.some((x) => x.payload.category === 'teach'));
});

test('compute: not enough history -> no remove_source suggestions', () => {
  const r = compute({ triages: triages.slice(1), proposals: [], teachNotes: [], sourcesConfigured: ['Quiet'], month: '2026-09' });
  assert.equal(r.coverageOk, false);
  assert.deepEqual(r.silent, []);
});

test('previousMonth', () => {
  assert.equal(previousMonth(new Date('2026-01-01T09:00:00')), '2025-12');
  assert.equal(previousMonth(new Date('2026-10-01T09:00:00')), '2026-09');
});

test('retro end-to-end writes the report, reads teach scores and saves proposals (dry-run saves none)', async () => {
  const ctx = testCtx({ config: { sources: [{ type: 'rss', name: 'Quiet', url: 'https://q.test/f' }] } });
  ensureSkeleton(ctx.vault);
  triages.forEach((t, i) => writeJson(atticPath(ctx.vault, 'triage', `t${i}.json`), t));
  fs.writeFileSync(atticPath(ctx.vault, 'teach', 'a.md'), stringifyFrontmatter({ title: 'A', score: 90 }, 'x'));
  fs.writeFileSync(atticPath(ctx.vault, 'teach', 'b.md'), stringifyFrontmatter({ title: 'B', score: 70 }, 'x'));
  const dry = await retro(ctx, { month: '2026-09', dryRun: true });
  assert.equal(dry.proposals.length, 0);
  assert.equal(dry.teach.avgScore, 80);
  const real = await retro(ctx, { month: '2026-09' });
  assert.equal(real.proposals.length, 1);
  const md = fs.readFileSync(atticPath(ctx.vault, 'retro', '2026-09.md'), 'utf8');
  assert.match(md, /월간 회고 2026-09/);
  assert.match(md, /평균 점수 80\.0/);
});

test('compute: d items are counted and do not turn the ratios into NaN/0', () => {
  const r = compute({
    triages: [tri('2026-09-02T00:00:00Z', [item('S', 'a'), item('S', 'd'), item('S', 'd'), item('S', 'c')])],
    proposals: [], teachNotes: [], sourcesConfigured: ['S'], month: '2026-09',
  });
  assert.equal(r.perSource.S.d, 2);
  assert.equal(r.ratios.d, 0.5);
  assert.equal(r.ratios.a, 0.25);
});
