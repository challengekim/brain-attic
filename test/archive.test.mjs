// Archive executor (2026-11-09, D-003): an approved d card moves the note to 90_Archive/<same path> inside the vault.
// Never deletes a note: link + unlink (no clobber), hash checked before and after, every move in a ledger that
// `attic archive undo` reverses. Links that would break block the move. Also: discarded cards are never proposed again,
// and the dated project focus (triage.projectFocus) steers try cards.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCtx } from './helpers.mjs';
import { atticPath, ensureSkeleton } from '../src/vault.mjs';
import { createProposal, decide, getProposal, saveProposal, withdraw, discard } from '../src/proposals.mjs';
import { archiveTarget, planArchive, runArchive, undoArchive, readArchiveLedger } from '../src/archive.mjs';
import { apply } from '../src/apply.mjs';
import { activeFocus, applyFocus } from '../src/focus.mjs';
import { guideFor } from '../src/feedback.mjs';
import { tryRank, triageInputKey } from '../src/triage.mjs';
import { buildDescriptors, discardedKeys } from '../src/review.mjs';

const T0 = new Date('2026-11-04T12:00:00+09:00');
const LATER = new Date('2026-11-05T12:00:00+09:00');
const emptyAud = { suggestions: [], scannedFiles: 0, models: {}, tools: {} };

function setup() {
  const ctx = testCtx();
  ensureSkeleton(ctx.vault);
  return ctx;
}
function note(vault, rel, body = `# ${path.basename(rel, '.md')}\n본문\n`) {
  const abs = path.join(vault, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}
function approvedDrop(vault, file, title = path.basename(file, '.md')) {
  const p = createProposal(vault, { kind: 'drop', summary: [`버릴 후보 — ${title}`], payload: { op: 'archive_note', title, file, kind: 'vault' }, source: 'review' }, T0).proposal;
  decide(vault, p.id, 'approved', { by: 'decision-api', now: LATER });
  return getProposal(vault, p.id);
}
const exists = (vault, rel) => fs.existsSync(path.join(vault, rel));

test('[archive] target mirrors the path under 90_Archive', () => {
  assert.equal(archiveTarget('10_Knowledge/References/A/b c.md'), '90_Archive/10_Knowledge/References/A/b c.md');
});

test('[archive] plan: ready / missing / already archived / conflict / invalid paths', () => {
  const { vault } = setup();
  note(vault, '10_Knowledge/References/A/ready.md');
  note(vault, '90_Archive/10_Knowledge/References/A/done.md'); // moved earlier by hand
  note(vault, '10_Knowledge/References/A/clash.md', 'one');
  note(vault, '90_Archive/10_Knowledge/References/A/clash.md', 'two');
  const ps = ['10_Knowledge/References/A/ready.md', '10_Knowledge/References/A/gone.md', '10_Knowledge/References/A/done.md',
    '10_Knowledge/References/A/clash.md', '../outside.md', '_attic/x.md', '90_Archive/10_Knowledge/y.md', '/abs/z.md', '10_Knowledge/no-ext']
    .map((f) => approvedDrop(vault, f));
  const plan = planArchive(vault, ps);
  const st = Object.fromEntries(plan.map((r) => [r.from, r.status]));
  assert.equal(st['10_Knowledge/References/A/ready.md'], 'ready');
  assert.equal(st['10_Knowledge/References/A/gone.md'], 'missing');
  assert.equal(st['10_Knowledge/References/A/done.md'], 'already');
  assert.equal(st['10_Knowledge/References/A/clash.md'], 'conflict');
  for (const bad of ['../outside.md', '_attic/x.md', '90_Archive/10_Knowledge/y.md', '/abs/z.md', '10_Knowledge/no-ext']) assert.equal(st[bad], 'invalid', bad);
});

test('[archive] a symlinked note or a symlinked folder on the way is refused', () => {
  const { vault } = setup();
  const real = note(vault, 'elsewhere/real.md');
  fs.mkdirSync(path.join(vault, '10_Knowledge/References'), { recursive: true });
  fs.symlinkSync(real, path.join(vault, '10_Knowledge/References/link.md'));
  fs.symlinkSync(path.join(vault, 'elsewhere'), path.join(vault, '10_Knowledge/References/dirlink'));
  const plan = planArchive(vault, [approvedDrop(vault, '10_Knowledge/References/link.md'), approvedDrop(vault, '10_Knowledge/References/dirlink/real.md')]);
  assert.deepEqual(plan.map((r) => r.status), ['invalid', 'invalid']);
});

test('[archive] links: a unique-name [[wikilink]] survives the move; path links, relative md links and same-name notes block it', () => {
  const { vault } = setup();
  note(vault, '10_Knowledge/References/A/plain.md');
  note(vault, '10_Knowledge/References/A/pathlinked.md');
  note(vault, '10_Knowledge/References/A/mdlinked note.md');
  note(vault, '10_Knowledge/References/A/twin.md');
  note(vault, '95_Recovered/twin.md');
  note(vault, '10_Knowledge/References/A/attic-only.md');
  note(vault, '2026-11-01.md', [
    '- [[plain]] — 이름 링크', '- [[plain|별칭]] ![[plain#제목]]',
    '- [[10_Knowledge/References/A/pathlinked]]',
    '- [보기](10_Knowledge/References/A/mdlinked%20note.md)',
    '- [[twin]]', '- `10_Knowledge/References/A/plain.md` (경로 언급)', '',
  ].join('\n'));
  note(vault, '_attic/reviews/2026-W45.md', '- [[10_Knowledge/References/A/attic-only|t]]\n');
  const files = ['plain', 'pathlinked', 'mdlinked note', 'twin', 'attic-only'].map((n) => `10_Knowledge/References/A/${n}.md`);
  const plan = planArchive(vault, files.map((f) => approvedDrop(vault, f)));
  const by = Object.fromEntries(plan.map((r) => [path.basename(r.from, '.md'), r]));
  assert.equal(by.plain.status, 'ready');
  assert.equal(by.plain.links.name, 3);
  assert.equal(by.plain.links.pathMentions, 1); // a backtick path is not a link but gets stale: reported
  assert.equal(by.pathlinked.status, 'blocked');
  assert.match(by.pathlinked.reason, /경로 링크/);
  assert.equal(by['mdlinked note'].status, 'blocked');
  assert.equal(by.twin.status, 'blocked');
  assert.match(by.twin.reason, /같은 이름/);
  assert.equal(by['attic-only'].status, 'ready'); // attic's own generated sheets do not block, only counted
  assert.equal(by['attic-only'].links.attic, 1);
  assert.equal(by.plain.leavesPublic, true); // 10_Knowledge/References is on challengekim's allowlist
});

test('[archive] run --limit moves only that many; hash equal, source gone, ledger written, prompt file removed', async () => {
  const ctx = setup();
  const { vault } = ctx;
  const files = ['a', 'b', 'c', 'd'].map((n) => `10_Knowledge/References/A/${n}.md`);
  files.forEach((f, i) => note(vault, f, `내용 ${i}\n`));
  const ps = files.map((f) => approvedDrop(vault, f));
  fs.writeFileSync(atticPath(vault, 'approved', `${ps[0].id}.prompt.md`), 'old instruction');
  saveProposal(vault, { ...getProposal(vault, ps[0].id), promptFile: `approved/${ps[0].id}.prompt.md` });
  const r = await runArchive(ctx, { limit: 3, now: LATER });
  assert.equal(r.moved.length, 3);
  for (const f of files.slice(0, 3)) {
    assert.ok(!exists(vault, f), f);
    assert.ok(exists(vault, archiveTarget(f)));
  }
  assert.ok(exists(vault, files[3]));
  const led = readArchiveLedger(vault);
  assert.equal(led.length, 3);
  assert.ok(led.every((e) => e.status === 'moved' && /^[0-9a-f]{64}$/.test(e.sha256) && e.to.startsWith('90_Archive/')));
  const p0 = getProposal(vault, ps[0].id);
  assert.equal(p0.status, 'applied');
  assert.equal(p0.archivedTo, archiveTarget(files[0]));
  assert.ok(!fs.existsSync(atticPath(vault, 'approved', `${ps[0].id}.prompt.md`)));
  assert.equal(p0.promptFile, undefined);
  assert.equal(getProposal(vault, ps[3].id).status, 'approved');
});

test('[archive] dry-run (no --run) changes nothing', async () => {
  const ctx = setup();
  note(ctx.vault, '10_Knowledge/References/A/x.md');
  const p = approvedDrop(ctx.vault, '10_Knowledge/References/A/x.md');
  const r = await runArchive(ctx, { dryRun: true, now: LATER });
  assert.equal(r.plan[0].status, 'ready');
  assert.equal(r.moved.length, 0);
  assert.ok(exists(ctx.vault, '10_Knowledge/References/A/x.md'));
  assert.equal(getProposal(ctx.vault, p.id).status, 'approved');
  assert.equal(readArchiveLedger(ctx.vault).length, 0);
});

test('[archive] an already archived note (moved by hand) is closed as applied without touching files', async () => {
  const ctx = setup();
  note(ctx.vault, '90_Archive/10_Knowledge/References/A/x.md');
  const p = approvedDrop(ctx.vault, '10_Knowledge/References/A/x.md');
  const r = await runArchive(ctx, { now: LATER });
  assert.equal(r.already.length, 1);
  const q = getProposal(ctx.vault, p.id);
  assert.equal(q.status, 'applied');
  assert.equal(q.archivedTo, '90_Archive/10_Knowledge/References/A/x.md');
  assert.equal(q.archivedBefore, true);
});

test('[archive] never overwrites: a file that appears at the target is a conflict, both stay', async () => {
  const ctx = setup();
  note(ctx.vault, '10_Knowledge/References/A/x.md', 'mine');
  note(ctx.vault, '90_Archive/10_Knowledge/References/A/x.md', 'other');
  const p = approvedDrop(ctx.vault, '10_Knowledge/References/A/x.md');
  const r = await runArchive(ctx, { now: LATER });
  assert.equal(r.moved.length, 0);
  assert.equal(fs.readFileSync(path.join(ctx.vault, '10_Knowledge/References/A/x.md'), 'utf8'), 'mine');
  assert.equal(fs.readFileSync(path.join(ctx.vault, '90_Archive/10_Knowledge/References/A/x.md'), 'utf8'), 'other');
  assert.equal(getProposal(ctx.vault, p.id).status, 'approved');
});

test('[archive] undo puts the note back (hash checked) and refuses when the archived copy changed or the source is taken', async () => {
  const ctx = setup();
  const { vault } = ctx;
  note(vault, '10_Knowledge/References/A/x.md', 'x\n');
  note(vault, '10_Knowledge/References/A/y.md', 'y\n');
  note(vault, '10_Knowledge/References/A/z.md', 'z\n');
  const [px, py, pz] = ['x', 'y', 'z'].map((n) => approvedDrop(vault, `10_Knowledge/References/A/${n}.md`));
  await runArchive(ctx, { now: LATER });
  const u = undoArchive(vault, [px.id], { now: LATER });
  assert.equal(u.restored.length, 1);
  assert.equal(fs.readFileSync(path.join(vault, '10_Knowledge/References/A/x.md'), 'utf8'), 'x\n');
  assert.ok(!exists(vault, '90_Archive/10_Knowledge/References/A/x.md'));
  assert.equal(readArchiveLedger(vault).find((e) => e.proposalId === px.id).status, 'undone');
  assert.ok(getProposal(vault, px.id).archiveUndoneAt);
  fs.writeFileSync(path.join(vault, '90_Archive/10_Knowledge/References/A/y.md'), 'edited\n');
  note(vault, '10_Knowledge/References/A/z.md', 'new z\n');
  const u2 = undoArchive(vault, [py.id, pz.id], { now: LATER });
  assert.equal(u2.restored.length, 0);
  assert.equal(u2.refused.length, 2);
  // an undone card is not moved again by the next run
  const again = await runArchive(ctx, { now: LATER });
  assert.equal(again.moved.length, 0);
  assert.ok(exists(vault, '10_Knowledge/References/A/x.md'));
});

test('[archive] apply moves approved d cards (whitelisted) and writes no instruction file; a blocked one stays approved', async () => {
  const ctx = setup();
  const { vault } = ctx;
  note(vault, '10_Knowledge/References/A/ok.md');
  note(vault, '10_Knowledge/References/A/linked.md');
  note(vault, '2026-11-01.md', '[[10_Knowledge/References/A/linked]]\n');
  const ok = approvedDrop(vault, '10_Knowledge/References/A/ok.md');
  const linked = approvedDrop(vault, '10_Knowledge/References/A/linked.md');
  const r = await apply(ctx, { now: LATER });
  assert.ok(r.applied.some((x) => x.id === ok.id && x.op === 'archive_note'));
  assert.ok(r.skipped.some((x) => x.id === linked.id));
  assert.equal(r.prompts.length, 0);
  assert.ok(!fs.existsSync(atticPath(vault, 'approved', `${ok.id}.prompt.md`)));
  assert.ok(exists(vault, '90_Archive/10_Knowledge/References/A/ok.md'));
  assert.equal(getProposal(vault, linked.id).status, 'approved');
});

// ---------------------------------------------------------------- discard

test('[discard] only a closed card (withdrawn/expired/rejected) can be discarded; a discarded card is not revived', () => {
  const { vault } = setup();
  const d = { kind: 'teach', summary: ['깊게 읽고 설명해 볼 것: t'], payload: { op: 'queue_teach', title: 't', url: 'https://x.test/t', kind: 'url', file: '10_Knowledge/t.md', project: null, minutes: 30 } };
  const p = createProposal(vault, d, T0).proposal;
  assert.throws(() => discard(vault, p.id), /pending/);
  withdraw(vault, p.id, { now: T0 });
  const q = discard(vault, p.id, { reason: '폐기 확정', now: LATER });
  assert.ok(q.discardedAt);
  const again = createProposal(vault, d, LATER);
  assert.equal(again.created, false);
  assert.equal(again.proposal.status, 'withdrawn');
});

test('[discard] review never proposes a discarded item again, whatever the wording or week', () => {
  const { vault } = setup();
  const p = createProposal(vault, { kind: 'teach', summary: ['x'], payload: { op: 'queue_teach', title: 't', url: '', kind: 'vault', file: '10_Knowledge/t.md', project: null, minutes: 30 } }, T0).proposal;
  withdraw(vault, p.id, { now: T0 });
  discard(vault, p.id, { now: T0 });
  const keys = discardedKeys(vault);
  assert.ok(keys.has('10_Knowledge/t.md'));
  const items = [{ id: 'i1', class: 'c', action: 'learn', title: 't (새 제목)', file: '10_Knowledge/t.md', reason: 'r', minutes: 20 },
    { id: 'i2', class: 'c', action: 'learn', title: 'other', file: '10_Knowledge/o.md', reason: 'r', minutes: 20 }];
  const ds = buildDescriptors({ items }, emptyAud, {}, [], new Map(), { discarded: keys });
  assert.deepEqual(ds.map((d) => d.payload.file), ['10_Knowledge/o.md']);
});

// ---------------------------------------------------------------- project focus

const FOCUS = [
  { project: 'rivalhook', state: 'focus', from: '2026-11-16', to: '2026-11-22', note: '집중 주간' },
  { project: 'onemove', state: 'sleep', to: '2026-11-22', note: '일단 미룸. 집중 주간 2026-11-23~29' },
  { project: 'onemove', state: 'focus', from: '2026-11-23', to: '2026-11-29' },
  { project: '', state: 'focus' }, { project: 'x', state: 'nap' }, { project: 'y', state: 'focus', from: '2026-12-02', to: '2026-12-01' }, { project: 'z', state: 'sleep', to: '11/30' },
];
const at = (d) => new Date(`${d}T08:30:00+09:00`);

test('[focus] dated windows switch on and off by themselves; malformed entries are ignored', () => {
  const cfg = { triage: { projectFocus: FOCUS } };
  const s = (d) => activeFocus(cfg, at(d)).map((f) => `${f.project}:${f.state}`).sort();
  assert.deepEqual(s('2026-11-09'), ['onemove:sleep']);
  assert.deepEqual(s('2026-11-16'), ['onemove:sleep', 'rivalhook:focus']);
  assert.deepEqual(s('2026-11-22'), ['onemove:sleep', 'rivalhook:focus']);
  assert.deepEqual(s('2026-11-23'), ['onemove:focus']);
  assert.deepEqual(s('2026-11-30'), []);
  assert.deepEqual(activeFocus({}, at('2026-11-16')), []);
});

test('[focus] try on a sleeping project becomes a; try on a focused project is marked and ranked first', () => {
  const active = activeFocus({ triage: { projectFocus: FOCUS } }, at('2026-11-16'));
  const items = [
    { id: 'i1', class: 'c', action: 'try', project: 'onemove', reason: 'r', minutes: 30, pain: 'p', next: 'n', check: 'c', priority: 1 },
    { id: 'i2', class: 'c', action: 'try', project: 'rivalhook', reason: 'r', minutes: 30, pain: 'p', next: 'n', check: 'c', priority: 3 },
    { id: 'i3', class: 'c', action: 'try', project: 'casebook', reason: 'r', minutes: 30, pain: 'p', next: 'n', check: 'c', priority: 1 },
    { id: 'i4', class: 'c', action: 'learn', project: 'onemove', reason: 'r', minutes: 30 },
  ];
  const r = applyFocus(items, active);
  assert.equal(r.slept, 1);
  assert.equal(items[0].class, 'a');
  assert.equal(items[0].action, undefined);
  assert.match(items[0].reason, /재움/);
  assert.equal(items[1].focus, true);
  assert.equal(items[3].class, 'c'); // only try is held back by the code; learn is left to the prompt
  assert.deepEqual([items[2], items[1]].sort(tryRank).map((x) => x.id), ['i2', 'i3']);
});

test('[focus] the classifier is told the current project states, and the saved triage is redone when they change', () => {
  const ctx = setup();
  ctx.config = { ...ctx.config, triage: { ...ctx.config.triage, projectFocus: FOCUS } };
  const g16 = guideFor(ctx, { now: at('2026-11-16') });
  assert.match(g16.text, /rivalhook: 집중/);
  assert.match(g16.text, /onemove: 재움/);
  assert.match(g16.text, /이것만 따른다/);
  // same states on two days -> same key (no daily re-classification); a boundary -> new key
  assert.equal(guideFor(ctx, { now: at('2026-11-17') }).key, g16.key);
  assert.notEqual(guideFor(ctx, { now: at('2026-11-23') }).key, g16.key);
  assert.notEqual(triageInputKey(ctx, guideFor(ctx, { now: at('2026-11-23') })), triageInputKey(ctx, g16));
});
