import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { testCtx, fakeLlmEnv, tmp, ROOT } from './helpers.mjs';
import { save, parseSaveArgs } from '../src/save.mjs';
import { gatherItems, triage, TRIAGE_SCHEMA, triageInputKey } from '../src/triage.mjs';
import { review, triageIsStale, systemReviewDescriptor, buildDescriptors, kindOfItem } from '../src/review.mjs';
import { listProposals } from '../src/proposals.mjs';
import { atticPath, ensureSkeleton, parseFrontmatter } from '../src/vault.mjs';
import { writeJson, isoWeek as isoWeekOf } from '../src/util.mjs';

const llm = { runner: 'claude', model: null, timeoutMs: 20000 };

test('parseSaveArgs: first http(s) word is the link, the rest (plus --note) is the memo', () => {
  assert.deepEqual(parseSaveArgs(['https://e.test/a?utm_source=x', '좋은', '글'], {}), { url: 'https://e.test/a?utm_source=x', memo: '좋은 글', title: '' });
  assert.deepEqual(parseSaveArgs([], { note: '메모만', title: ' T ' }), { url: '', memo: '메모만', title: 'T' });
});

test('save writes a frontmatter note under _attic/saved only; refuses empty input and non-web links', () => {
  const ctx = testCtx();
  const r = save(ctx, { url: 'https://e.test/a/?utm_source=x', memo: '나중에 읽기', now: new Date('2026-10-07T12:00:00') });
  assert.ok(r.file.startsWith(atticPath(ctx.vault, 'saved') + path.sep));
  assert.match(path.basename(r.file), /^2026-10-07-.+\.md$/);
  const { data } = parseFrontmatter(fs.readFileSync(r.file, 'utf8'));
  assert.equal(data.url, 'https://e.test/a');
  assert.equal(data.title, '나중에 읽기');
  assert.equal(data.source, 'attic save');
  assert.throws(() => save(ctx, {}), /링크나 메모/);
  assert.throws(() => save(ctx, { url: 'file:///etc/passwd' }), /http/);
  const memo = save(ctx, { memo: '원문 없는 아이디어' });
  assert.equal(parseFrontmatter(fs.readFileSync(memo.file, 'utf8')).data.url, undefined);
  // nothing outside _attic/
  assert.deepEqual(fs.readdirSync(ctx.vault), ['_attic']);
});

test('triage reads manual saves first, and a saved link wins over the same link from a feed', async () => {
  const ctx = testCtx({ env: fakeLlmEnv(), config: { triage: { include: [], weeklyMinutes: 180 }, llm } });
  ensureSkeleton(ctx.vault);
  const now = new Date();
  fs.writeFileSync(atticPath(ctx.vault, 'inbox', `${now.toISOString().slice(0, 10)}.md`), '### [Feed copy](https://e.test/same)\n- source: F\n> s\n\n### [Other](https://e.test/other)\n- source: F\n> s\n');
  save(ctx, { url: 'https://e.test/same', memo: '내가 저장', now });
  const week = (await import('../src/util.mjs')).isoWeek(now);
  const items = gatherItems(ctx, week, now);
  assert.equal(items[0].source, 'saved');
  assert.equal(items[0].title, '내가 저장');
  assert.equal(items.find((i) => i.title === 'Feed copy').dupOf, items[0].id);
  const t = await triage(ctx, { now });
  const mine = t.items.find((i) => i.source === 'saved');
  assert.notEqual(mine.class, 'd');
  assert.match(mine.file, /^_attic\/saved\//);
  assert.equal(t.items.find((i) => i.title === 'Feed copy').class, 'd');
});

test('a new manual save makes this week\'s saved triage stale (review re-classifies)', async () => {
  const ctx = testCtx();
  ensureSkeleton(ctx.vault);
  const saved = { schema: TRIAGE_SCHEMA, inputKey: triageInputKey(ctx), generatedAt: new Date(Date.now() - 60000).toISOString(), errors: [], items: [{ id: 'i1' }] };
  assert.equal(triageIsStale(ctx, ctx.vault, saved), false);
  save(ctx, { memo: '새 메모' });
  assert.equal(triageIsStale(ctx, ctx.vault, saved), true);
});

test('new models -> one "re-review the whole system" proposal per week; none without new-model events', async () => {
  const aud = { scannedFiles: 2, models: { 'claude-opus-5': ['a'], 'gpt-image-2': ['b'] }, tools: {}, suggestions: [] };
  assert.equal(systemReviewDescriptor([{ kind: 'price_drop', id: 'x' }], aud), null);
  const d = systemReviewDescriptor([{ kind: 'new', id: 'v/a' }, { kind: 'kie_new', id: 'k/b' }, { kind: 'new', id: 'v/a' }], aud);
  assert.equal(d.payload.op, 'system_review');
  assert.deepEqual(d.payload.newModels, ['v/a', 'k/b']);
  assert.deepEqual(d.payload.modelsInUse, ['claude-opus-5', 'gpt-image-2']);
  const tri = { items: [] };
  assert.equal(buildDescriptors(tri, aud, { system_review: 1 }, [{ kind: 'new', id: 'v/a' }]).length, 0, 'weekly cap');

  const ctx = testCtx({ env: fakeLlmEnv(), config: { triage: { include: [], weeklyMinutes: 180 }, llm, notifiers: [] } });
  ensureSkeleton(ctx.vault);
  const now = new Date('2026-10-07T12:00:00');
  writeJson(atticPath(ctx.vault, 'radar', 'events.json'), [{ key: 'or:new:v/n', date: '2026-10-06', source: 'openrouter', kind: 'new', id: 'v/n', name: 'N', capabilities: [], detail: '신규' }]);
  const r1 = await review(ctx, { now });
  const sys = listProposals(ctx.vault).filter((p) => p.payload.op === 'system_review');
  assert.equal(sys.length, 1);
  assert.match(fs.readFileSync(r1.sheetFile, 'utf8'), /시스템 전체를 다시 검토/);
  writeJson(atticPath(ctx.vault, 'radar', 'events.json'), [{ key: 'or:new:v/m', date: '2026-10-07', source: 'openrouter', kind: 'new', id: 'v/m', name: 'M', capabilities: [], detail: '신규' }]);
  await review(ctx, { now });
  assert.equal(listProposals(ctx.vault).filter((p) => p.payload.op === 'system_review').length, 1, 'still one this week');
});

test('CLI: attic save <url> 메모 writes into the configured vault', () => {
  const home = tmp();
  const vault = path.join(home, 'v');
  const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
  const run = (args) => spawnSync(process.execPath, [path.join(ROOT, 'bin/attic.mjs'), ...args], { env, encoding: 'utf8' });
  assert.equal(run(['init', '--vault', vault, '--yes']).status, 0);
  const r = run(['save', 'https://e.test/x', '읽을', '것']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /저장: .*_attic\/saved\//);
  assert.equal(fs.readdirSync(path.join(vault, '_attic', 'saved')).length, 1);
  const bad = run(['save']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /링크나 메모/);
});

test('kindOfItem: a saved link is read from the web later, a saved memo from the note', () => {
  assert.equal(kindOfItem({ source: 'saved', file: '_attic/saved/x.md', url: 'https://e.test/a' }), 'url');
  assert.equal(kindOfItem({ source: 'saved', file: '_attic/saved/y.md', url: '' }), 'vault');
  assert.equal(kindOfItem({ source: 'vault', file: 'notes/z.md', url: 'https://e.test/b' }), 'vault');
});

test('two URL-less memos with the same title are both classified (not deduplicated by title)', () => {
  const ctx = testCtx();
  const now = new Date();
  save(ctx, { memo: '같은 첫 줄\n본문 A', now });
  save(ctx, { memo: '같은 첫 줄\n본문 B', now: new Date(now.getTime() + 1) });
  const week = isoWeekOf(now);
  const items = gatherItems(ctx, week, now).filter((i) => i.source === 'saved');
  assert.equal(items.length, 2);
  assert.ok(items.every((i) => !i.dupOf));
});
