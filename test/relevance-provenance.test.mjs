// Who wrote a note's «why it matters to me» line? The user's own judgement weighs most; a line a save tool's AI
// wrote is only a lead (OpenCrab: tell AI-written evidence from the original, prefer the original).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCtx } from './helpers.mjs';
import { atticPath, ensureSkeleton } from '../src/vault.mjs';
import { isoWeek } from '../src/util.mjs';
import { buildPrompt, DEFAULT_RATIOS, gatherItems, userJudged } from '../src/triage.mjs';
import { buildDescriptors, renderSheet } from '../src/review.mjs';
import { save } from '../src/save.mjs';

const aud = { scannedFiles: 0, models: {}, tools: {}, suggestions: [] };
const note = (fm) => `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')}\n---\n본문\n`;

function vaultWith(files, triage = {}) {
  const ctx = testCtx({ config: { triage: { include: ['Refs'], ...triage } } });
  ensureSkeleton(ctx.vault);
  fs.mkdirSync(path.join(ctx.vault, 'Refs'), { recursive: true });
  for (const [name, fm] of Object.entries(files)) fs.writeFileSync(path.join(ctx.vault, 'Refs', name), note(fm));
  return ctx;
}
const byTitle = (items) => Object.fromEntries(items.map((i) => [i.title, i]));

test('gatherItems: unmarked my_relevance is AI-written by default; relevance_by marks the author; config can flip the default', () => {
  const files = {
    'plain.md': { title: 'PLAIN', source: 'https://e.test/1', my_relevance: '저장 도구가 붙인 쓸모' },
    'mine.md': { title: 'MINE', source: 'https://e.test/2', my_relevance: '내가 적은 판단', relevance_by: 'user' },
    'ai.md': { title: 'AI', source: 'https://e.test/3', my_relevance: 'AI 추정', relevance_by: 'AI' },
    'odd.md': { title: 'ODD', source: 'https://e.test/4', my_relevance: '누가 썼는지 이상한 값', relevance_by: 'robot' },
    'none.md': { title: 'NONE', source: 'https://e.test/5' },
  };
  const now = new Date();
  const t = byTitle(gatherItems(vaultWith(files), isoWeek(now), now));
  assert.equal(t.PLAIN.relevanceBy, 'ai', 'no marker -> AI-written (the default)');
  assert.equal(t.MINE.relevanceBy, 'user');
  assert.equal(t.AI.relevanceBy, 'ai', 'case-insensitive');
  assert.equal(t.ODD.relevanceBy, 'ai', 'an unknown marker falls back to the default');
  assert.equal(t.NONE.relevance, undefined);
  assert.equal(t.NONE.relevanceBy, undefined, 'no relevance -> no author');

  const t2 = byTitle(gatherItems(vaultWith(files, { relevanceBy: 'user' }), isoWeek(now), now));
  assert.equal(t2.PLAIN.relevanceBy, 'user', 'triage.relevanceBy: "user" for vaults where people write it by hand');
  assert.equal(t2.AI.relevanceBy, 'ai', 'an explicit marker beats the config default');
  const t3 = byTitle(gatherItems(vaultWith(files, { relevanceBy: 'nonsense' }), isoWeek(now), now));
  assert.equal(t3.PLAIN.relevanceBy, 'ai', 'an invalid config value -> ai');
});

test('gatherItems: the memo given to `attic save <URL> <memo>` is the user\'s own judgement; a memo-only note is not', () => {
  const ctx = vaultWith({});
  const now = new Date();
  save(ctx, { url: 'https://e.test/saved', memo: 'casebook 마케팅 막힌 곳에 바로 쓸 것', now });
  save(ctx, { memo: '그냥 떠오른 생각', now });
  const items = gatherItems(ctx, isoWeek(now), now);
  const linked = items.find((i) => i.url === 'https://e.test/saved');
  assert.equal(linked.relevance, 'casebook 마케팅 막힌 곳에 바로 쓸 것');
  assert.equal(linked.relevanceBy, 'user');
  const memoOnly = items.find((i) => i.title === '그냥 떠오른 생각');
  assert.equal(memoOnly.relevance, undefined, 'a memo without a link is the content itself, not a judgement about it');
});

test('buildPrompt: each relevance says who wrote it, and AI-written relevance cannot ground a try on its own', () => {
  const batch = [
    { id: 'i1', title: 'U', url: '', summary: 's', relevance: '내 판단', relevanceBy: 'user' },
    { id: 'i2', title: 'A', url: '', summary: 's', relevance: 'AI 추정', relevanceBy: 'ai' },
  ];
  const p = buildPrompt(batch, ['casebook — x — y'], DEFAULT_RATIOS, new Map());
  assert.match(p, /"id":"i1"[^\n]*"relevance":"내 판단","relevance_by":"user"/);
  assert.match(p, /"id":"i2"[^\n]*"relevance":"AI 추정","relevance_by":"ai"/);
  assert.match(p, /relevance_by "ai"/);
  assert.match(p, /AI 가 붙인 relevance 만으로는 pain 이 아니다/);
  assert.doesNotMatch(p, /relevance 는 사용자가 이 노트를 저장하면서 직접 적은/, 'the old blanket claim is gone');
});

test('userJudged: only user-written relevance counts; old results without an author do not', () => {
  assert.equal(userJudged({ relevance: 'x', relevanceBy: 'user' }), true);
  assert.equal(userJudged({ relevance: 'x', relevanceBy: 'ai' }), false);
  assert.equal(userJudged({ relevance: 'x' }), false, 'a result saved before authors were recorded');
  assert.equal(userJudged({ relevanceBy: 'user' }), false);
});

test('try ranking and the sheet: AI-written relevance neither lifts a try nor lists a skipped note as «your judgement»', () => {
  const tryItem = (title, extra = {}) => ({ id: title, title, url: `https://e.test/${title}`, source: 'vault', class: 'c', action: 'try', project: 'casebook', pain: 'p', next: 'n', check: 'c', reason: 'r', minutes: 30, priority: 2, ...extra });
  const items = [
    tryItem('AIREL', { relevance: 'AI 추정', relevanceBy: 'ai' }),
    tryItem('USERREL', { relevance: '내 판단', relevanceBy: 'user' }),
    { id: 'sa', title: 'SKIP-AI', url: 'https://e.test/sa', source: 'vault', class: 'a', reason: '인지만', relevance: 'AI 추정', relevanceBy: 'ai' },
    { id: 'su', title: 'SKIP-USER', url: 'https://e.test/su', source: 'vault', class: 'd', reason: '버림', relevance: '내 판단', relevanceBy: 'user' },
  ];
  const picked = buildDescriptors({ items }, aud).filter((d) => d.payload.op === 'try_in_project').map((d) => d.payload.title);
  assert.deepEqual(picked, ['USERREL', 'AIREL'], 'the user-judged try goes first');
  const sheet = renderSheet({ vault: '/v', week: 'W', tri: { counts: { a: 1, b: 0, c: 2, d: 1, unclassified: 0 }, usedMinutes: 0, weeklyMinutes: null, errors: [], items }, aud, events: [], descriptors: [], dryRun: true, nowIso: 'now' });
  const skipped = sheet.split('### 들이지 않기로 한 것')[1]?.split('\n## ')[0] || '';
  assert.match(skipped, /SKIP-USER/);
  assert.doesNotMatch(skipped, /SKIP-AI/);
});

test('triageInputKey: changing triage.relevanceBy makes this week\'s saved triage stale', async () => {
  const { triageInputKey } = await import('../src/triage.mjs');
  const guide = { key: 'g' };
  const k1 = triageInputKey(testCtx({ config: { triage: {} } }), guide);
  const k2 = triageInputKey(testCtx({ config: { triage: { relevanceBy: 'user' } } }), guide);
  const k3 = triageInputKey(testCtx({ config: { triage: { relevanceBy: 'ai' } } }), guide);
  assert.notEqual(k1, k2);
  assert.equal(k1, k3, 'unset and the default "ai" are the same input');
});

test('P2: only string markers count; malformed attic-save fields never become a user judgement; a moved or later-annotated memo stays the user\'s', () => {
  const now = new Date();
  const ctx = vaultWith({
    'arr.md': { title: 'ARR', source: 'https://e.test/a1', my_relevance: 'x', relevance_by: ['user'] },
    'bad.md': { title: 'BAD', source: 'attic save', url: true, summary: 42 },
    'blank.md': { title: 'BLANK', source: 'attic save', url: 'https://e.test/b', summary: '   ' },
    'ftp.md': { title: 'FTP', source: 'attic save', url: 'ftp://e.test/f', summary: '메모' },
    'moved.md': { title: 'MOVED', source: 'attic save', url: 'https://e.test/m', summary: '옮긴 내 메모' },
    'both.md': { title: 'BOTH', source: 'attic save', url: 'https://e.test/both', summary: '내 메모', my_relevance: 'AI 가 나중에 붙인 줄' },
  }, { relevanceBy: ['user'] });
  const t = byTitle(gatherItems(ctx, isoWeek(now), now));
  assert.equal(t.ARR.relevanceBy, 'ai', 'an array marker and an array config value are ignored');
  assert.equal(t.BAD.relevance, undefined, 'url: true / summary: 42 is not a saved memo');
  assert.equal(t.BLANK.relevance, undefined);
  assert.equal(t.FTP.relevance, undefined, 'only http(s) links');
  assert.equal(t.MOVED.relevanceBy, 'user', 'an attic save note moved into an included folder keeps its memo');
  assert.equal(t.MOVED.relevance, '옮긴 내 메모');
  assert.equal(t.BOTH.relevanceBy, 'user', 'an unmarked AI line added later does not hide the memo');
  assert.equal(t.BOTH.relevance, '내 메모');
});
