import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeItem, renderTriage } from '../src/triage.mjs';
import { buildDescriptors } from '../src/review.mjs';

const emptyAud = { suggestions: [], scannedFiles: 0, models: {}, tools: {} };

test('[d] the classifier may return d', () => {
  assert.equal(normalizeItem({ id: 'i1', class: 'd', reason: '광고' }, []).class, 'd');
  assert.equal(normalizeItem({ id: 'i1', class: 'e', reason: 'x' }, []), null);
});

test('[d] d vault notes become archive proposals (prompt-only), capped per week; feed items are not proposed', () => {
  const items = [
    ...Array.from({ length: 7 }, (_, i) => ({ id: `v${i}`, class: 'd', title: `n${i}`, file: `10_Knowledge/n${i}.md`, reason: '중복' })),
    { id: 'f1', class: 'd', title: 'feed', url: 'https://x.example', reason: '광고' },
  ];
  const ds = buildDescriptors({ items }, emptyAud).filter((d) => d.payload.op === 'archive_note');
  assert.equal(ds.length, 5);
  assert.ok(ds.every((d) => d.payload.file && d.kind === 'drop'));
  const rest = buildDescriptors({ items }, emptyAud, { archive_note: 4 }).filter((d) => d.payload.op === 'archive_note');
  assert.equal(rest.length, 1);
});

test('[d] the sheet has a d section', () => {
  const t = {
    week: '2026-W41',
    items: [{ id: 'i1', class: 'd', title: 't', url: 'https://x.example', reason: '중복' }],
    counts: { a: 0, b: 0, c: 0, d: 1, unclassified: 0 },
    usedMinutes: 0, weeklyMinutes: 180, demoted: 0, errors: [],
  };
  assert.match(renderTriage(t), /## d — 버릴 후보/);
});
