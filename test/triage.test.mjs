import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCtx, fakeLlmEnv } from './helpers.mjs';
import { triage, gatherItems, applyBudget, normalizeItem } from '../src/triage.mjs';
import { atticPath, ensureSkeleton } from '../src/vault.mjs';

const NOW = new Date('2026-10-07T12:00:00'); // 2026-W41

function setup({ mode = 'ok', budget = 180, runner = 'claude' } = {}) {
  const ctx = testCtx({ env: fakeLlmEnv(mode), config: { triage: { include: ['Refs'], weeklyMinutes: budget }, llm: { runner, model: null, timeoutMs: 20000 } } });
  ensureSkeleton(ctx.vault);
  fs.writeFileSync(atticPath(ctx.vault, 'projects.md'), '# 일\n- 뉴스레터 — 주간 소식 — 고르기\n- 앱 — 만들기 — 속도\n');
  const inbox = ['# Inbox', ''];
  for (let i = 1; i <= 6; i++) inbox.push(`### [Item ${i}](https://e.test/${i})`, '- source: Feed', `> summary ${i}`, '');
  fs.writeFileSync(atticPath(ctx.vault, 'inbox', '2026-10-06.md'), inbox.join('\n'));
  fs.writeFileSync(atticPath(ctx.vault, 'inbox', '2026-09-01.md'), '### [Old](https://e.test/old)\n- source: Feed\n'); // other week
  fs.mkdirSync(path.join(ctx.vault, 'Refs'));
  fs.writeFileSync(path.join(ctx.vault, 'Refs', 'note.md'), '---\ntitle: "Vault Note"\nurl: https://v.test/n\nsummary: from vault\ntags: [ai, agents]\n---\nbody');
  fs.writeFileSync(path.join(ctx.vault, 'Refs', 'stale.md'), 'old');
  const old = new Date('2026-08-01'); fs.utimesSync(path.join(ctx.vault, 'Refs', 'stale.md'), old, old);
  return ctx;
}

test('gatherItems: this week inbox + recently modified vault notes (frontmatter), not other weeks or stale notes', () => {
  const ctx = setup();
  const items = gatherItems(ctx, '2026-W41', new Date());
  const titles = items.map((i) => i.title);
  assert.ok(titles.includes('Item 1') && titles.includes('Vault Note'));
  assert.ok(!titles.includes('Old') && !titles.includes('stale'));
  const v = items.find((i) => i.title === 'Vault Note');
  assert.deepEqual(v.tags, ['ai', 'agents']);
  assert.equal(v.summary, 'from vault');
});

test('triage with a working runner: classes, project link only from the list, c has minutes', async () => {
  const ctx = setup();
  const t = await triage(ctx, { week: '2026-W41', now: new Date() });
  assert.equal(t.items.length, 7);
  assert.equal(t.counts.unclassified, 0);
  assert.deepEqual(t.items.map((i) => i.class).slice(0, 3), ['a', 'b', 'c']);
  assert.equal(t.items.find((i) => i.class === 'a').project, null);          // "not in list" -> null
  const c = t.items.find((i) => i.class === 'c');
  assert.equal(c.project, '뉴스레터', 'stored as the project name (first part of the line)');
  assert.equal(c.minutes, 40);
  assert.ok(fs.existsSync(atticPath(ctx.vault, 'triage', '2026-W41.json')));
});

test('triage with broken JSON -> everything 미분류, nothing invented', async () => {
  const ctx = setup({ mode: 'broken' });
  const t = await triage(ctx, { week: '2026-W41', now: new Date() });
  assert.equal(t.counts.unclassified, 7);
  assert.equal(t.counts.a + t.counts.b + t.counts.c, 0);
  assert.equal(t.errors.length, 1);
});

test('triage with runner none / schema violation -> 미분류', async () => {
  const none = await triage(setup({ runner: 'none', mode: 'ok' }) , { week: '2026-W41', now: new Date() });
  assert.equal(none.counts.unclassified, 7);
  const bad = await triage(setup({ mode: 'badschema' }), { week: '2026-W41', now: new Date() });
  assert.equal(bad.counts.unclassified, 7);
});

test('partially invalid items: invalid ones become 미분류, valid kept', async () => {
  const t = await triage(setup({ mode: 'partial' }), { week: '2026-W41', now: new Date() });
  assert.equal(t.counts.a, 1);
  assert.equal(t.counts.unclassified, 6);
});

test('budget: c over weeklyMinutes is demoted to a and says so', async () => {
  const t = await triage(setup({ mode: 'allc', budget: 250 }), { week: '2026-W41', now: new Date() });
  assert.equal(t.counts.c, 2);          // 2 x 100 = 200 <= 250, third would be 300
  assert.equal(t.counts.a, 5);
  assert.equal(t.demoted, 5);
  assert.equal(t.usedMinutes, 200);
  const d = t.items.find((i) => i.demotedFrom === 'c');
  assert.match(d.reason, /강등/);
});

test('applyBudget prefers project-linked and shorter c items', () => {
  const items = [
    { id: 'x', class: 'c', minutes: 90, project: null, reason: 'r' },
    { id: 'y', class: 'c', minutes: 90, project: 'P', reason: 'r' },
    { id: 'z', class: 'c', minutes: 30, project: null, reason: 'r' },
  ];
  applyBudget(items, 120);
  assert.deepEqual(items.map((i) => i.class), ['a', 'c', 'c']);
});

test('normalizeItem rejects c without minutes and unknown classes', () => {
  assert.equal(normalizeItem({ id: 'i1', class: 'c', reason: 'r' }, []), null);
  assert.equal(normalizeItem({ id: 'i1', class: 'z', reason: 'r' }, []), null);
  assert.equal(normalizeItem({ id: 'i1', class: 'a', reason: '' }, []), null);
  assert.equal(normalizeItem({ id: 'i1', class: 'A', reason: 'r', project: 'p' }, ['p']).project, 'p');
});
