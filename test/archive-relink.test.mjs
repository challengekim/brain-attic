// Archive relink (2026-11-13, owner brief «옮길 때 노트 안의 경로 링크도 새 경로로»): a note other notes reach by its
// FULL vault path ([[10_Knowledge/…/x|t]], or the path written out like the wiki index's `10_Knowledge/…/x.md`) is
// moved and those references are rewritten to 90_Archive/…; undo writes them back. Anything we cannot rewrite exactly
// (partial or case-differing paths, markdown links, links from notes that move too or are archived) still blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { testCtx } from './helpers.mjs';
import { ensureSkeleton, replaceNoteIfUnchanged } from '../src/vault.mjs';
import { createProposal, decide, getProposal } from '../src/proposals.mjs';
import { finishRelinks, planArchive, readArchiveLedger, rewriteRefs, runArchive, undoArchive } from '../src/archive.mjs';
import { apply } from '../src/apply.mjs';

const T0 = new Date('2026-11-04T12:00:00+09:00');
const LATER = new Date('2026-11-05T12:00:00+09:00');
const P = '10_Knowledge/References/RSS/Articles/사쿠라 미코 2nd 라이브';
const F = `${P}.md`;
const A = `90_Archive/${P}`;

function setup() { const ctx = testCtx(); ensureSkeleton(ctx.vault); return ctx; }
function note(vault, rel, body = `# ${path.basename(rel, '.md')}\n본문\n`) {
  const abs = path.join(vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}
const read = (vault, rel) => fs.readFileSync(path.join(vault, rel), 'utf8');
function approvedDrop(vault, file) {
  const p = createProposal(vault, { kind: 'drop', summary: [`버릴 후보 — ${file}`], payload: { op: 'archive_note', title: path.basename(file, '.md'), file, kind: 'vault' }, source: 'review' }, T0).proposal;
  decide(vault, p.id, 'approved', { by: 'decision-api', now: LATER });
  return getProposal(vault, p.id);
}

const ENTITY = [
  '# 넥덕', '',
  `- 2026-11-03 [[${P}|사쿠라 미코 2nd 라이브]]`,
  `- [[${P}]] · [[${F}]] · [[${P}#요약|요약]] · ![[${P}]] · [[/${P}]]`,
  `| 표 | [[${P}\\|별칭]] |`,
  '- [[사쿠라 미코 2nd 라이브]] (이름 링크는 그대로)', '',
].join('\n');
const INDEX = [
  '- [[사쿠라 미코 2nd 라이브]] — 요약',
  `  \`${F}\` · source: https://example.com/a · 등록 2026-11-03`,
  `  이미 보관된 다른 표기: \`90_Archive/${F}\``,
  `  다른 노트: \`${P} 2.md\` · \`${F}x\` · \`x/${F}\``, '',
].join('\n');

test('[relink] rewriteRefs: exact full-path wikilinks and path mentions only; aliases, headings, embeds, table escapes kept', () => {
  const r = rewriteRefs(ENTITY, F, `90_Archive/${F}`);
  assert.equal(r.count, 7);
  assert.ok(r.text.includes(`[[${A}|사쿠라 미코 2nd 라이브]]`));
  assert.ok(r.text.includes(`[[${A}]] · [[90_Archive/${F}]] · [[${A}#요약|요약]] · ![[${A}]] · [[/${A}]]`));
  assert.ok(r.text.includes(`[[${A}\\|별칭]]`));
  assert.ok(r.text.includes('- [[사쿠라 미코 2nd 라이브]] (이름 링크는 그대로)'));
  const m = rewriteRefs(INDEX, F, `90_Archive/${F}`);
  assert.equal(m.count, 1);
  assert.ok(m.text.includes(`\`90_Archive/${F}\` · source`));
  assert.ok(m.text.includes(`이미 보관된 다른 표기: \`90_Archive/${F}\``)); // not doubled
  assert.ok(m.text.includes(`\`${P} 2.md\` · \`${F}x\` · \`x/${F}\``)); // other paths untouched
  // reversible: rewriting back gives the original text
  assert.equal(rewriteRefs(r.text, `90_Archive/${F}`, F).text, ENTITY);
  // known limit: a note that ALREADY spelled the archive path gets that one turned back too on undo (it was stale anyway)
  assert.ok(rewriteRefs(m.text, `90_Archive/${F}`, F).text.includes(`이미 보관된 다른 표기: \`${F}\``));
});

test('[relink] plan: exact path links no longer block (counted as fixable); partial, case-differing and md links still block', () => {
  const { vault } = setup();
  note(vault, F);
  note(vault, '10_Knowledge/References/A/partial.md');
  note(vault, '10_Knowledge/References/A/Cased.md');
  note(vault, '10_Knowledge/References/A/md.md');
  note(vault, '_system/entities/넥덕.md', ENTITY);
  note(vault, '_system/wiki/index.md', INDEX);
  note(vault, '2026-11-01.md', '[[A/partial]]\n[[10_knowledge/references/a/cased]]\n[보기](10_Knowledge/References/A/md.md)\n');
  const files = [F, '10_Knowledge/References/A/partial.md', '10_Knowledge/References/A/Cased.md', '10_Knowledge/References/A/md.md'];
  const plan = planArchive(vault, files.map((f) => approvedDrop(vault, f)));
  const by = Object.fromEntries(plan.map((r) => [r.from, r]));
  assert.equal(by[F].status, 'ready', by[F].reason);
  assert.deepEqual(by[F].relink, ['_system/entities/넥덕.md', '_system/wiki/index.md']);
  assert.equal(by['10_Knowledge/References/A/partial.md'].status, 'blocked');
  assert.equal(by['10_Knowledge/References/A/Cased.md'].status, 'blocked');
  assert.equal(by['10_Knowledge/References/A/md.md'].status, 'blocked');
});

test('[relink] an exact path link from a note that moves too, or from an archived note, still blocks (no edits to those)', () => {
  const { vault } = setup();
  note(vault, '10_Knowledge/References/A/a.md', '[[10_Knowledge/References/A/b|b]]\n');
  note(vault, '10_Knowledge/References/A/b.md');
  note(vault, '10_Knowledge/References/A/c.md');
  note(vault, '90_Archive/old/z.md', '[[10_Knowledge/References/A/c]]\n');
  const plan = planArchive(vault, ['a', 'b', 'c'].map((n) => approvedDrop(vault, `10_Knowledge/References/A/${n}.md`)));
  const st = Object.fromEntries(plan.map((r) => [path.basename(r.from, '.md'), r.status]));
  assert.equal(st.b, 'blocked');
  assert.equal(st.c, 'blocked');
  assert.equal(st.a, 'ready');
});

test('[relink] run moves the note, rewrites the referencing notes, records them; _attic is not edited; undo restores the text', async () => {
  const ctx = setup();
  const { vault } = ctx;
  note(vault, F, '# 원본\n');
  note(vault, '_system/entities/넥덕.md', ENTITY);
  const index = INDEX.replace(/^ {2}이미 보관된.*\n/m, '');
  note(vault, '_system/wiki/index.md', index);
  const sheet = `- [[${P}|t]]\n`;
  note(vault, '_attic/reviews/2026-W46.md', sheet);
  const p = approvedDrop(vault, F);
  const r = await runArchive(ctx, { now: LATER });
  assert.equal(r.moved.length, 1, JSON.stringify(r.errors));
  assert.ok(fs.existsSync(path.join(vault, `90_Archive/${F}`)));
  assert.ok(!fs.existsSync(path.join(vault, F)));
  assert.ok(read(vault, '_system/entities/넥덕.md').includes(`[[${A}|사쿠라 미코 2nd 라이브]]`));
  assert.ok(!read(vault, '_system/entities/넥덕.md').includes(`[[${P}|`));
  assert.ok(read(vault, '_system/wiki/index.md').includes(`\`90_Archive/${F}\` · source`));
  assert.equal(read(vault, '_attic/reviews/2026-W46.md'), sheet);
  const e = readArchiveLedger(vault).find((x) => x.proposalId === p.id);
  assert.ok(e.relinkedAt);
  assert.deepEqual(e.relinked.map((x) => [x.file, x.count]), [['_system/entities/넥덕.md', 7], ['_system/wiki/index.md', 1]]);
  // the owner edits the entity page afterwards: undo keeps that edit and only turns the links back
  fs.appendFileSync(path.join(vault, '_system/entities/넥덕.md'), '- 새 메모\n');
  const u = undoArchive(vault, [p.id], { now: LATER });
  assert.equal(u.restored.length, 1);
  assert.equal(read(vault, '_system/entities/넥덕.md'), ENTITY + '- 새 메모\n');
  assert.equal(read(vault, '_system/wiki/index.md'), index);
  assert.equal(read(vault, F), '# 원본\n');
});

test('[relink] a move recorded but not relinked (crash in between) is relinked by the next run; nothing is rewritten twice', async () => {
  const ctx = setup();
  const { vault } = ctx;
  note(vault, F);
  note(vault, '_system/entities/넥덕.md', ENTITY);
  const p = approvedDrop(vault, F);
  await runArchive(ctx, { now: LATER });
  const once = read(vault, '_system/entities/넥덕.md');
  // simulate the crash: put the old text back and mark the relink unfinished
  fs.writeFileSync(path.join(vault, '_system/entities/넥덕.md'), ENTITY);
  const led = readArchiveLedger(vault);
  const e = led.find((x) => x.proposalId === p.id);
  delete e.relinkedAt; delete e.relinked;
  fs.writeFileSync(path.join(vault, '_attic/archive/ledger.json'), JSON.stringify(led));
  const done = finishRelinks(vault, LATER);
  assert.equal(done.length, 1);
  assert.equal(read(vault, '_system/entities/넥덕.md'), once);
  assert.equal(finishRelinks(vault, LATER).length, 0);
  assert.equal(read(vault, '_system/entities/넥덕.md'), once);
});

test('[relink] the hourly apply moves and relinks the same way', async () => {
  const ctx = setup();
  const { vault } = ctx;
  note(vault, '10_Knowledge/References/A/linked.md');
  note(vault, '2026-11-01.md', '[[10_Knowledge/References/A/linked]]\n');
  const linked = approvedDrop(vault, '10_Knowledge/References/A/linked.md');
  const r = await apply(ctx, { now: LATER });
  assert.ok(r.applied.some((x) => x.id === linked.id), JSON.stringify(r));
  assert.equal(read(vault, '2026-11-01.md'), '[[90_Archive/10_Knowledge/References/A/linked]]\n');
});

test('[relink/self-review] a linking note we would refuse to rewrite (second hard link, not UTF-8) keeps blocking the move', () => {
  const { vault } = setup();
  note(vault, '10_Knowledge/References/A/h.md');
  note(vault, '10_Knowledge/References/A/u.md');
  note(vault, 'hub.md', '[[10_Knowledge/References/A/h]]\n');
  fs.linkSync(path.join(vault, 'hub.md'), path.join(vault, 'hub-copy.txt')); // nlink 2
  fs.writeFileSync(path.join(vault, 'latin.md'), Buffer.concat([Buffer.from('[[10_Knowledge/References/A/u]] '), Buffer.from([0xff, 0xfe]), Buffer.from('\n')]));
  const plan = planArchive(vault, ['h', 'u'].map((n) => approvedDrop(vault, `10_Knowledge/References/A/${n}.md`)));
  assert.deepEqual(plan.map((r) => r.status), ['blocked', 'blocked']);
});

test('[relink/self-review] the hourly apply finishes a pending relink even when no archive card is waiting', async () => {
  const ctx = setup();
  const { vault } = ctx;
  note(vault, F);
  note(vault, '_system/entities/넥덕.md', ENTITY);
  const p = approvedDrop(vault, F);
  await runArchive(ctx, { now: LATER });
  const once = read(vault, '_system/entities/넥덕.md');
  fs.writeFileSync(path.join(vault, '_system/entities/넥덕.md'), ENTITY);
  const led = readArchiveLedger(vault);
  const e = led.find((x) => x.proposalId === p.id);
  delete e.relinkedAt; delete e.relinked;
  fs.writeFileSync(path.join(vault, '_attic/archive/ledger.json'), JSON.stringify(led));
  await apply(ctx, { now: LATER });
  assert.equal(read(vault, '_system/entities/넥덕.md'), once);
});

// ---------------------------------------------------------------- Codex round 1 (P1 ×2, P2 undo retry)
test('[relink/r1] only exact references change: not another note named <path> copy, a URL, code blocks, aliases or bare text', () => {
  const text = [
    `[[${F} copy]] · [[${P} copy|x]]`,
    `https://example.com/view?file=${F}`,
    `[[다른 노트|${F}]] · [[다른 노트|\`${F}\`]]`,
    `그냥 적은 ${F} 경로`,
    '```', `[[${P}]] \`${F}\``, '```',
    '~~~md', `[[${P}|코드]]`, '~~~',
    `진짜: [[${P}|t]] \`${F}\``, '',
  ].join('\n');
  const r = rewriteRefs(text, F, `90_Archive/${F}`);
  assert.equal(r.count, 2);
  assert.equal(r.text, text.replace(`진짜: [[${P}|t]] \`${F}\``, `진짜: [[${A}|t]] \`90_Archive/${F}\``));
});

test('[relink/r1] an editor saving while we swap never loses its text (new file at the path, or an in-place write)', () => {
  const dir = fs.mkdtempSync(path.join(testCtx().vault, 'race-'));
  const abs = path.join(dir, 'n.md');
  fs.writeFileSync(abs, 'old\n');
  const raw = fs.readFileSync(abs);
  // 1) a new file appears at the path after we set the original aside: kept, ours dropped
  assert.throws(() => replaceNoteIfUnchanged(abs, raw, 'ours\n', 0o644, null, { afterAside: () => fs.writeFileSync(abs, 'NEW USER TEXT\n') }), /새로 저장/);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'NEW USER TEXT\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['n.md']);
  // 2) the original inode is written in place after we read it: that text is put back over ours
  fs.writeFileSync(abs, 'old\n');
  const raw2 = fs.readFileSync(abs);
  assert.throws(() => replaceNoteIfUnchanged(abs, raw2, 'ours\n', 0o644, null, { afterLink: (aside) => fs.writeFileSync(aside, 'EDITED IN PLACE\n') }), /바뀜/);
  assert.equal(fs.readFileSync(abs, 'utf8'), 'EDITED IN PLACE\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['n.md']);
  // 3) nothing happens meanwhile: ours, no leftovers
  replaceNoteIfUnchanged(abs, fs.readFileSync(abs), 'ours\n');
  assert.equal(fs.readFileSync(abs, 'utf8'), 'ours\n');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['n.md']);
});

test('[relink/r1] a crash mid-swap (original set aside, note missing) is put back by the next run, then relinked', async () => {
  const ctx = setup();
  const { vault } = ctx;
  note(vault, F);
  note(vault, '_system/entities/넥덕.md', ENTITY);
  const p = approvedDrop(vault, F);
  await runArchive(ctx, { now: LATER });
  const once = read(vault, '_system/entities/넥덕.md');
  // simulate: relink not finished, the entity page sits aside under a temp name and is missing at its path
  const led = readArchiveLedger(vault);
  const e = led.find((x) => x.proposalId === p.id);
  delete e.relinkedAt; delete e.relinked;
  fs.writeFileSync(path.join(vault, '_system/entities/.attic-relink-abc.orig'), ENTITY);
  fs.unlinkSync(path.join(vault, '_system/entities/넥덕.md'));
  e.relinkAside = { file: '_system/entities/넥덕.md', aside: '_system/entities/.attic-relink-abc.orig', tmp: '_system/entities/.attic-relink-abc.tmp', sha256: crypto.createHash('sha256').update(ENTITY).digest('hex') };
  fs.writeFileSync(path.join(vault, '_attic/archive/ledger.json'), JSON.stringify(led));
  finishRelinks(vault, LATER);
  assert.equal(read(vault, '_system/entities/넥덕.md'), once);
  assert.deepEqual(fs.readdirSync(path.join(vault, '_system/entities')), ['넥덕.md']);
  assert.equal(readArchiveLedger(vault).find((x) => x.proposalId === p.id).relinkAside, undefined);
});

test('[relink/r1] an undo whose link restore failed is retried by the next run', async () => {
  const ctx = setup();
  const { vault } = ctx;
  note(vault, F);
  note(vault, '_system/entities/넥덕.md', ENTITY);
  const p = approvedDrop(vault, F);
  await runArchive(ctx, { now: LATER });
  const ent = path.join(vault, '_system/entities/넥덕.md');
  fs.linkSync(ent, path.join(vault, '_system/entities/extra-name.txt')); // makes the rewrite refuse (second hard link)
  const u = undoArchive(vault, [p.id], { now: LATER });
  assert.equal(u.restored.length, 1);
  assert.ok(readArchiveLedger(vault).find((x) => x.proposalId === p.id).unrelinkError);
  fs.unlinkSync(path.join(vault, '_system/entities/extra-name.txt'));
  finishRelinks(vault, LATER);
  assert.equal(read(vault, '_system/entities/넥덕.md'), ENTITY);
  const e = readArchiveLedger(vault).find((x) => x.proposalId === p.id);
  assert.ok(e.unrelinkedAt);
  assert.equal(e.unrelinkError, undefined);
});
