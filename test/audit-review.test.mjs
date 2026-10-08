import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCtx, fakeLlmEnv, tmp } from './helpers.mjs';
import { scanText, suggest, audit } from '../src/audit.mjs';
import { review } from '../src/review.mjs';
import { listProposals } from '../src/proposals.mjs';
import { atticPath, ensureSkeleton } from '../src/vault.mjs';
import { writeJson } from '../src/util.mjs';

test('scanText finds model IDs (claude-/gpt-/gemini-/vendor/model) and CLI tools, not file paths', () => {
  const s = scanText('use claude-haiku-5.5 and gpt-image-2, gemini-3-flash. via openrouter anthropic/claude-opus-5. See src/foo/bar and ffmpeg -i x; run gh pr list; 이미지 생성');
  assert.deepEqual(s.models.sort(), ['anthropic/claude-opus-5', 'claude-haiku-5.5', 'claude-opus-5', 'gemini-3-flash', 'gpt-image-2']);
  assert.ok(s.tools.includes('ffmpeg') && s.tools.includes('gh'));
  assert.ok(!s.models.includes('src/foo'));
  assert.ok(s.caps.includes('image'));
});

const files = [
  { rel: 'skills/thumb/SKILL.md', models: ['gpt-image-2'], tools: [], caps: ['image'] },
  { rel: 'skills/notes/SKILL.md', models: ['claude-opus-5'], tools: [], caps: [] },
  { rel: 'scripts/llm.sh', models: ['openai/gpt-6-luna'], tools: [], caps: [] },
];
const ev = (o) => ({ key: `k:${o.id}:${o.kind}`, source: 'openrouter', detail: 'd', ...o });

test('suggest: new image-capable model -> image skills only; text-only new model -> nothing (substitution is another tool)', () => {
  const out = suggest(files, [
    ev({ kind: 'new', id: 'v/new-image', name: 'N', capabilities: ['image'], detail: '신규 모델 (출력 image)' }),
    ev({ kind: 'new', id: 'v/new-text', name: 'T', capabilities: [] }),
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, 'skills/thumb/SKILL.md');
  assert.match(out[0].text, /v\/new-image/);
  assert.match(out[0].text, /시도해 볼까\?$/);
});

test('suggest: price drop only for files that use that very model; price rise ignored; no duplicates', () => {
  const evs = [ev({ kind: 'price_drop', id: 'openai/gpt-6-luna', detail: 'prompt -40%' }), ev({ kind: 'price_rise', id: 'gpt-image-2' })];
  const out = suggest(files, [...evs, ...evs]);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, 'scripts/llm.sh');
});

test('audit() scans configured dirs and cross-checks recent radar events', async () => {
  const root = tmp('skills-');
  fs.mkdirSync(path.join(root, 'thumb'));
  fs.writeFileSync(path.join(root, 'thumb', 'SKILL.md'), '썸네일 이미지는 gpt-image-2 로 만든다. ffmpeg 도 쓴다.');
  const ctx = testCtx({ config: { audit: { paths: [root] } } });
  ensureSkeleton(ctx.vault);
  writeJson(atticPath(ctx.vault, 'radar', 'events.json'), [{ key: 'or:new:v/img', date: new Date().toISOString().slice(0, 10), source: 'openrouter', kind: 'new', id: 'v/img', name: 'Img', capabilities: ['image'], detail: '신규' }]);
  const r = await audit(ctx);
  assert.equal(r.scannedFiles, 1);
  assert.ok(r.models['gpt-image-2']);
  assert.ok(r.tools.ffmpeg);
  assert.equal(r.suggestions.length, 1);
});

test('review --dry-run writes the sheet but stores/sends nothing; real run stores proposals and notifies', async () => {
  const ctx = testCtx({ env: fakeLlmEnv('allc'), config: { triage: { include: [], weeklyMinutes: 250 }, llm: { runner: 'claude', model: null, timeoutMs: 20000 }, notifiers: [{ type: 'stdout' }] } });
  ensureSkeleton(ctx.vault);
  const now = new Date('2026-10-07T12:00:00'); // W41
  fs.writeFileSync(atticPath(ctx.vault, 'inbox', '2026-10-06.md'), '### [Deep one](https://e.test/1)\n- source: F\n> s\n\n### [Deep two](https://e.test/2)\n- source: F\n> s\n');
  const dry = await review(ctx, { dryRun: true, now });
  assert.equal(listProposals(ctx.vault).length, 0);
  assert.equal(dry.notified.length, 0);
  const sheet = fs.readFileSync(dry.sheetFile, 'utf8');
  assert.match(sheet, /승인 시트 2026-W41/);
  assert.match(sheet, /dry-run/);
  assert.match(sheet, /attic approve attic-[0-9a-f]{12}/);
  const real = await review(ctx, { now });
  assert.equal(real.proposals.length, 2);
  assert.equal(listProposals(ctx.vault, { status: 'pending' }).length, 2);
  assert.equal(real.notified[0].type, 'stdout');
  assert.ok(ctx.log.lines.some((l) => l.includes('결정 대기 2건')));
  // same ids as the dry-run sheet promised
  for (const id of real.proposals) assert.ok(sheet.includes(id));
  // re-running does not duplicate
  const again = await review(ctx, { now });
  assert.equal(listProposals(ctx.vault).length, 2);
  assert.deepEqual(again.proposals.sort(), real.proposals.sort());
});
