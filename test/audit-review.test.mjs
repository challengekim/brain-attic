import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCtx, fakeLlmEnv, tmp } from './helpers.mjs';
import { scanText, scanDir, suggest, audit } from '../src/audit.mjs';
import { review, retireStaleImprove } from '../src/review.mjs';
import { createProposal, decide, getProposal, listProposals } from '../src/proposals.mjs';
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
  assert.equal(out[0].file, 'skills/thumb');
  assert.deepEqual(out[0].files, ['skills/thumb/SKILL.md']);
  assert.match(out[0].text, /v\/new-image/);
  assert.match(out[0].text, /시도해 볼까\?$/);
});

test('suggest: price drop only for files that use that very model; price rise ignored; no duplicates', () => {
  const evs = [ev({ kind: 'price_drop', id: 'openai/gpt-6-luna', detail: 'prompt -40%' }), ev({ kind: 'price_rise', id: 'gpt-image-2' })];
  const out = suggest(files, [...evs, ...evs]);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, 'scripts/llm.sh');
});

const imgEvent = ev({ kind: 'new', source: 'kie', id: 'kie:flux3', name: 'FLUX 3 Klein Text to Image', capabilities: ['image'] });
const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const workspaceFiles = {
  'SKILL.md': '---\nname: google-workspace\ndescription: Docs, Sheets and Slides helpers.\n---\nInsert an image into a slide.',
  'scripts/docs_index.py': '# index inline image objects',
  'scripts/slides_helper.py': '# replace image placeholders',
  'references/docs.md': 'Images in docs',
  'references/sheets.md': 'IMAGE() formula',
};

test('known-bad: a deleted skill under skills/.trash (5 files about images) -> 0 suggestions; archive/disabled/dot dirs are skipped', () => {
  const root = path.join(tmp('skills-root-'), 'skills');
  for (const [rel, text] of Object.entries(workspaceFiles)) write(root, `.trash/1790652645842-59703-CVilpD/google-workspace/${rel}`, `${text} image`);
  write(root, '_archive/old-thumb/SKILL.md', '---\nname: old-thumb\ndescription: image thumbnails\n---\n');
  write(root, 'archive/older/SKILL.md', '---\nname: older\ndescription: image\n---\n');
  write(root, 'disabled-thumb/SKILL.md', '---\nname: x\ndescription: image\n---\n');
  write(root, 'live/.cache/img.md', 'image');
  write(root, '.hidden.md', 'image');
  const files = scanDir(root);
  assert.deepEqual(files.map((f) => f.rel), []);
  assert.deepEqual(suggest(files, [imgEvent]), []);
});

test('known-good: a live image skill -> exactly 1 suggestion however many of its files mention images; examples listed', () => {
  const root = path.join(tmp('skills-root-'), 'skills');
  write(root, 'thumb/SKILL.md', '---\nname: thumb\ndescription: |\n  블로그 썸네일 이미지를 만든다.\nallowed-tools: Bash\n---\nbody');
  for (let i = 1; i <= 5; i++) write(root, `thumb/references/r${i}.md`, `image prompt ${i}`);
  const files = scanDir(root);
  const out = suggest(files, [imgEvent, imgEvent]);
  assert.equal(out.length, 1);
  assert.equal(out[0].file, 'skills/thumb');
  assert.equal(out[0].files.length, 3);
  assert.match(out[0].text, /^`skills\/thumb` 가 image 관련 작업을/);
  assert.match(out[0].text, /kie\.ai 에 "FLUX 3 Klein Text to Image" 문서가 새로 생겼다 — 시도해 볼까\?$/);
  // More image docs/models the same week: still one card for the skill, naming them.
  const edit = ev({ kind: 'new', source: 'kie', id: 'kie:flux3-edit', name: 'FLUX 3 Klein Edit Image', capabilities: ['image'] });
  const more = suggest(files, [imgEvent, edit, ev({ kind: 'new', id: 'v/img2', capabilities: ['image', 'video'] })]);
  assert.equal(more.length, 1);
  assert.deepEqual(more[0].eventKeys, [imgEvent.key, edit.key, 'k:v/img2:new']);
  assert.match(more[0].text, /image 쪽에 새로 나온 것 3건 — "FLUX 3 Klein Text to Image"\(kie\.ai\), "FLUX 3 Klein Edit Image"\(kie\.ai\), `v\/img2` — 시도해 볼까\?$/);
});

test('declared purpose decides: SKILL.md (nearest, so nested skills are their own unit), else README.md, else a loose file header', () => {
  const root = path.join(tmp('skills-root-'), 'skills');
  for (const [rel, text] of Object.entries(workspaceFiles)) write(root, `google-workspace/${rel}`, text);
  write(root, 'pkg/README.md', 'Generates image variations.');
  write(root, 'pkg/lib/run.mjs', 'run()');
  write(root, 'cache/run.py', '# makes thumbnails'); // a folder that declares nothing -> no capability match
  write(root, 'synced/abc/pdf/SKILL.md', '---\nname: pdf\ndescription: extract images from PDFs\n---\n'); // nested skill
  write(root, 'synced/abc/pdf/scripts/x.py', 'image');
  write(root, 'make-thumb.sh', '#!/bin/sh\n# 썸네일을 만든다\n');
  write(root, 'backup.sh', '#!/bin/sh\n# 백업\n' + '\n'.repeat(20) + 'cp *.image dest'); // image only below the header
  const out = suggest(scanDir(root), [imgEvent]);
  assert.deepEqual(out.map((s) => s.file).sort(), ['skills/make-thumb.sh', 'skills/pkg', 'skills/synced/abc/pdf']);
});

test('price drop: one suggestion per skill, listing the files that use the model', () => {
  const out = suggest([
    { rel: 'skills/a/SKILL.md', models: ['gpt-6-luna'], tools: [], caps: [] },
    { rel: 'skills/a/scripts/x.sh', models: ['gpt-6-luna'], tools: [], caps: [] },
    { rel: 'skills/a/scripts/y.sh', models: [], tools: [], caps: [] },
  ], [ev({ kind: 'price_drop', id: 'openai/gpt-6-luna', detail: 'prompt -40%' })]);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].files, ['skills/a/SKILL.md', 'skills/a/scripts/x.sh']);
  assert.match(out[0].text, /\(파일 2개, 예: SKILL\.md, scripts\/x\.sh\)/);
});

test('audit.exclude drops prefixes as suggestions show them', async () => {
  const root = path.join(tmp('skills-root-'), 'skills');
  write(root, 'synced/abc/pdf/SKILL.md', '---\nname: pdf\ndescription: images\n---\n');
  write(root, 'thumb/SKILL.md', '---\nname: thumb\ndescription: image\n---\n');
  const ctx = testCtx({ config: { audit: { paths: [root], exclude: ['/skills/synced/'] } } });
  ensureSkeleton(ctx.vault);
  writeJson(atticPath(ctx.vault, 'radar', 'events.json'), [{ ...imgEvent, date: new Date().toISOString().slice(0, 10) }]);
  const r = await audit(ctx);
  assert.equal(r.scannedFiles, 1);
  assert.deepEqual(r.suggestions.map((s) => s.file), ['skills/thumb']);
});

test('retireStaleImprove: pending per-file or .trash improve cards are withdrawn; answered and grouped ones stay', () => {
  const ctx = testCtx();
  ensureSkeleton(ctx.vault);
  const mk = (payload, summary) => createProposal(ctx.vault, { kind: 'improve', summary: [summary], payload: { op: 'improve_candidate', eventKey: 'k', capability: 'image', ...payload } }).proposal;
  const trashed = mk({ file: 'skills/.trash/1/google-workspace/scripts/docs_index.py' }, 't');
  const perFile = mk({ file: 'skills/thumb/references/r1.md' }, 'p');
  const answered = mk({ file: 'skills/thumb/references/r2.md' }, 'a');
  decide(ctx.vault, answered.id, 'rejected', { by: 'cli' });
  const grouped = mk({ file: 'skills/thumb', files: ['skills/thumb/SKILL.md'] }, 'g');
  const other = createProposal(ctx.vault, { kind: 'teach', summary: ['x'], payload: { op: 'queue_teach', title: 'x' } }).proposal;
  assert.deepEqual(retireStaleImprove(ctx.vault).sort(), [trashed.id, perFile.id].sort());
  assert.equal(getProposal(ctx.vault, trashed.id).status, 'withdrawn');
  assert.equal(getProposal(ctx.vault, answered.id).status, 'rejected');
  assert.equal(getProposal(ctx.vault, grouped.id).status, 'pending');
  assert.equal(getProposal(ctx.vault, other.id).status, 'pending');
  assert.deepEqual(retireStaleImprove(ctx.vault), []); // idempotent
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
