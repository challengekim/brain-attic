// Third independent review: one regression test per finding, tagged [n].
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { testCtx, fakeLlmEnv, routeFetch, tmp } from './helpers.mjs';
import { teach, listDue } from '../src/teach.mjs';
import { collect } from '../src/collect.mjs';
import { createProposal, decide, getProposal, listProposals } from '../src/proposals.mjs';
import * as gi from '../src/notify/github-issues.mjs';
import { buildDescriptors, renderSheet, review, triageIsStale, MAX_AUTO } from '../src/review.mjs';
import { apply } from '../src/apply.mjs';
import { atticPath, ensureSkeleton, parseFrontmatter } from '../src/vault.mjs';
import { schedule, renderPlist, renderCronBlock, configEnvFor, JOBS } from '../src/schedule.mjs';
import { isoWeek } from '../src/util.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const FAKE_TEACH = path.join(HERE, 'fixtures', 'fake-teach-llm.mjs');

function teachCtx() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-r3-'));
  const logs = [];
  const promptLog = path.join(vault, 'prompts.log');
  const env = { ...process.env, HOME: vault, BRAIN_ATTIC_LLM_CMD: `${process.execPath} ${FAKE_TEACH}`, FAKE_TEACH_LOG: promptLog };
  const ctx = {
    env, home: vault, vault,
    config: { llm: { runner: 'claude', timeoutMs: 20000 }, teach: {} },
    log: { info: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')) },
    fetch: async () => { throw new Error('no network in tests'); },
  };
  fs.mkdirSync(path.join(vault, '_attic', 'teach'), { recursive: true });
  const setQueue = (q) => fs.writeFileSync(path.join(vault, '_attic', 'teach', 'queue.json'), JSON.stringify(q));
  const prompts = () => (fs.existsSync(promptLog) ? fs.readFileSync(promptLog, 'utf8') : '');
  return { ctx, vault, logs, setQueue, prompts };
}

// ---------------------------------------------------------------- [1]

test('[1] --next never reads a local file named by a queue url (legacy item without kind -> title only)', async () => {
  const { ctx, vault, setQueue, prompts } = teachCtx();
  fs.writeFileSync(path.join(vault, 'private.md'), 'TOP-SECRET-LOCAL-CONTENT');
  setQueue([{ proposalId: 'attic-1', title: 'prompt caching', url: '~/private.md' }]);
  assert.equal(await teach(['--next', '--generate-only'], ctx), 0);
  assert.ok(!prompts().includes('TOP-SECRET-LOCAL-CONTENT'));
  const saved = JSON.parse(fs.readFileSync(path.join(vault, '_attic', 'teach', 'prompt-caching.pack.json'), 'utf8'));
  assert.notEqual(saved.sourceKind, 'file');
});

test('[1] --next: kind url must be http(s); kind vault reads only a real in-vault note', async () => {
  const { ctx, vault, setQueue, prompts } = teachCtx();
  fs.writeFileSync(path.join(vault, 'private.md'), 'TOP-SECRET-LOCAL-CONTENT');
  setQueue([{ proposalId: 'a', title: 't', url: '/etc/hosts', kind: 'url' }]);
  await assert.rejects(() => teach(['--next', '--generate-only'], ctx), /http/);

  fs.mkdirSync(path.join(vault, 'Refs'));
  fs.writeFileSync(path.join(vault, 'Refs', 'n.md'), 'VAULT-NOTE-BODY');
  setQueue([{ proposalId: 'b', title: 't', url: '', kind: 'vault', file: '../private.md' }]);
  await assert.rejects(() => teach(['--next', '--generate-only'], ctx), /볼트/);
  setQueue([{ proposalId: 'b', title: 't', url: '', kind: 'vault', file: path.join(vault, 'private.md') }]);
  await assert.rejects(() => teach(['--next', '--generate-only'], ctx), /상대경로/);

  const outside = tmp('outside-');
  fs.writeFileSync(path.join(outside, 'x.md'), 'OUTSIDE');
  fs.symlinkSync(path.join(outside, 'x.md'), path.join(vault, 'Refs', 'link.md'));
  fs.symlinkSync(outside, path.join(vault, 'Refs', 'dir'));
  for (const file of ['Refs/link.md', 'Refs/dir/x.md']) {
    setQueue([{ proposalId: 'c', title: 't', url: '', kind: 'vault', file }]);
    await assert.rejects(() => teach(['--next', '--generate-only'], ctx), /심볼릭|볼트/);
  }
  assert.ok(!prompts().includes('OUTSIDE'));

  setQueue([{ proposalId: 'd', title: 'Vault topic', url: '', kind: 'vault', file: 'Refs/n.md' }]);
  assert.equal(await teach(['--next', '--generate-only'], ctx), 0);
  assert.ok(prompts().includes('VAULT-NOTE-BODY'));
  const saved = JSON.parse(fs.readFileSync(path.join(vault, '_attic', 'teach', 'prompt-caching.pack.json'), 'utf8'));
  assert.equal(saved.sourceKind, 'vault');
});

test('[1] collect drops feed links that are not http(s)', async () => {
  const feed = `<rss><channel>
    <item><title>local</title><link>~/private.md</link></item>
    <item><title>file</title><link>file:///etc/passwd</link></item>
    <item><title>js</title><link>javascript:alert(1)</link></item>
    <item><title>ok</title><link>https://good.test/a</link></item></channel></rss>`;
  const ctx = testCtx({ config: { sources: [{ url: 'https://feed.test/rss', name: 'F' }] }, fetch: routeFetch({ 'feed.test': feed }) });
  const r = await collect(ctx, { now: new Date('2026-10-07T12:00:00') });
  assert.equal(r.added, 1);
  const inbox = fs.readFileSync(atticPath(ctx.vault, 'inbox', '2026-10-07.md'), 'utf8');
  assert.match(inbox, /good\.test/);
  assert.ok(!/private\.md|passwd|javascript:/.test(inbox));
});

// ---------------------------------------------------------------- [2]

function fakeGh() {
  const dir = tmp('fakegh3-');
  const log = path.join(dir, 'calls.log'), issues = path.join(dir, 'issues.json');
  fs.writeFileSync(issues, '{}');
  fs.writeFileSync(path.join(dir, 'gh'), `#!${process.execPath}
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const db = JSON.parse(fs.readFileSync(${JSON.stringify(issues)}, 'utf8'));
if (a[0] === 'api' && a[1] === 'user') console.log('Owner');
else if (a[0] === 'issue' && a[1] === 'create') console.log('https://github.com/o/r/issues/7');
else if (a[0] === 'issue' && a[1] === 'view') console.log(JSON.stringify(db[a[2]] || { comments: [], state: 'OPEN' }));
`, { mode: 0o755 });
  return { dir, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)), setIssue: (n, v) => fs.writeFileSync(issues, JSON.stringify({ [n]: v })) };
}
const mkProp = () => ({ kind: 'improve', summary: ['스킬 X 를 개선할까?'], payload: { op: 'improve_candidate' } });
const approveComment = { state: 'OPEN', comments: [{ body: 'approve', author: { login: 'owner' } }] };

test('[2] explicit empty allowedUsers = nobody (no gh-login fallback, owner cannot approve)', async () => {
  const gh = fakeGh();
  const ctx = testCtx({ env: { PATH: `${gh.dir}:${process.env.PATH}` } });
  const cfg = { type: 'github-issues', repo: 'o/r', allowedUsers: [] };
  const p = createProposal(ctx.vault, mkProp()).proposal;
  await gi.publish(ctx, cfg, [p]);
  assert.ok(!gh.calls().some((c) => c[0] === 'api'), 'must not look up the gh login when the key is present');
  assert.deepEqual(getProposal(ctx.vault, p.id).external['github-issues'].approvers, []);
  gh.setIssue('7', approveComment);
  const r = await gi.pull(ctx, cfg);
  assert.deepEqual(r.changed, []);
  assert.equal(getProposal(ctx.vault, p.id).status, 'pending');
});

test('[2] emptying allowedUsers later revokes the approver stored at publish time; absent key keeps using it', async () => {
  const gh = fakeGh();
  const ctx = testCtx({ env: { PATH: `${gh.dir}:${process.env.PATH}` } });
  const p = createProposal(ctx.vault, mkProp()).proposal;
  await gi.publish(ctx, { type: 'github-issues', repo: 'o/r' }, [p]); // key absent -> gh login stored
  assert.deepEqual(getProposal(ctx.vault, p.id).external['github-issues'].approvers, ['owner']);
  gh.setIssue('7', approveComment);
  const revoked = await gi.pull(ctx, { type: 'github-issues', repo: 'o/r', allowedUsers: [] });
  assert.deepEqual(revoked.changed, []);
  assert.equal(getProposal(ctx.vault, p.id).status, 'pending');
  const kept = await gi.pull(ctx, { type: 'github-issues', repo: 'o/r' });
  assert.deepEqual(kept.changed, [p.id]);
});

// ---------------------------------------------------------------- [3]

test('[3] attic-review skill saves proposals with a real review when none are pending', () => {
  const s = fs.readFileSync(path.join(ROOT, 'skills', 'attic-review', 'SKILL.md'), 'utf8');
  assert.match(s, /`attic review`\(dry-run 아님\)/);
  assert.ok(!/비어 있으면 `attic review --dry-run`/.test(s));
});

// ---------------------------------------------------------------- [4]

const PACK = {
  title: 'Prompt caching',
  explanation: 'Caching stores the prompt prefix.',
  quiz: [
    { question: 'q1', choices: ['a', 'b', 'c', 'd'], answer: 1, why: 'w' },
    { question: 'q2', choices: ['a', 'b', 'c', 'd'], answer: 0, why: 'w' },
  ],
  teach_back: [{ prompt: 'Explain it.', rubric: ['prefix'] }],
};
const GRADE = { scores: { accuracy: 4, completeness: 4, own_words: 4, example: 4 }, missing: [], wrong: [], feedback: 'good' };

test('[4] --save-session stores pack.json + md in the CLI format; the skill never writes markdown', async () => {
  const { ctx, vault } = teachCtx();
  const f = path.join(vault, 'session.json');
  fs.writeFileSync(f, JSON.stringify({ pack: PACK, source: 'chat', session: { quizCorrect: 2, score: 1, answers: [{ prompt: 'Explain it.', answer: 'my words', grade: GRADE }] } }));
  assert.equal(await teach(['--save-session', f], ctx), 0);
  const dir = path.join(vault, '_attic', 'teach');
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'prompt-caching.pack.json'), 'utf8'));
  assert.equal(saved.sessions.length, 1);
  assert.equal(saved.sessions[0].score, 100, 'score is recomputed from the grades, not trusted');
  assert.equal(saved.sourceKind, 'conversation');
  const { data } = parseFrontmatter(fs.readFileSync(path.join(dir, 'prompt-caching.md'), 'utf8'));
  assert.equal(data.reviews, 1);
  assert.ok(data.next_review);
  // a second save appends
  assert.equal(await teach(['--save-session', f], ctx), 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'prompt-caching.pack.json'), 'utf8')).sessions.length, 2);
  // invalid input is refused, nothing written
  fs.writeFileSync(f, JSON.stringify({ pack: { title: 'x' } }));
  await assert.rejects(() => teach(['--save-session', f], ctx), /pack/);
  const skill = fs.readFileSync(path.join(ROOT, 'skills', 'attic-teach', 'SKILL.md'), 'utf8');
  assert.match(skill, /attic teach --save-session/);
  assert.match(skill, /Do \*\*not\*\* write the markdown note yourself/);
});

test('[4] --review on a note with markdown but no pack.json ends with a clear message, not a crash', async () => {
  const { ctx, vault, logs } = teachCtx();
  fs.writeFileSync(path.join(vault, '_attic', 'teach', 'handmade.md'), '---\ntitle: x\n---\nbody');
  ctx.io = { print() {}, ask: async () => '', askMulti: async () => '' };
  const code = await teach(['--review', 'handmade'], ctx);
  assert.equal(code, 1);
  assert.ok(logs.some((l) => /pack 이 없습니다/.test(l) && /attic teach <원문>/.test(l)));
});

// ---------------------------------------------------------------- [5] [6]

const item = (id, cls, extra = {}) => ({ id, title: `T ${id}`, url: '', source: 'vault', class: cls, project: null, reason: 'r', ...extra });
const emptyAud = { suggestions: [], scannedFiles: 0, models: {}, tools: {} };

test('[5] queue_teach proposal keeps file + kind, and apply puts them in the queue', async () => {
  const tri = { items: [item('i1', 'c', { file: 'Refs/n.md', minutes: 30, url: 'https://v.test/n' }), item('i2', 'c', { url: 'https://e.test/1', source: 'Feed', minutes: 20 }), item('i3', 'c', { minutes: 10 })] };
  const ds = buildDescriptors(tri, emptyAud);
  assert.deepEqual(ds.map((d) => [d.payload.kind, d.payload.file]), [['vault', 'Refs/n.md'], ['url', undefined], ['topic', undefined]]);
  const ctx = testCtx();
  ensureSkeleton(ctx.vault);
  for (const d of ds) { const { proposal } = createProposal(ctx.vault, d); decide(ctx.vault, proposal.id, 'approved'); }
  const r = await apply(ctx);
  assert.equal(r.applied.length, 3);
  const q = JSON.parse(fs.readFileSync(atticPath(ctx.vault, 'teach', 'queue.json'), 'utf8'));
  assert.deepEqual(q.map((x) => [x.kind, x.file]), [['vault', 'Refs/n.md'], ['url', undefined], ['topic', undefined]]);
});

test('[6] b items: listed in the sheet (top 15), at most 5 note_auto proposals, apply writes only a prompt file', async () => {
  const bs = Array.from({ length: 20 }, (_, n) => item(`b${n}`, 'b', { url: `https://e.test/b${n}`, source: 'Feed' }));
  const tri = { items: bs, counts: { a: 0, b: 20, c: 0, unclassified: 0 }, usedMinutes: 0, weeklyMinutes: 180, demoted: 0, errors: [] };
  const ds = buildDescriptors(tri, emptyAud);
  assert.equal(ds.length, MAX_AUTO);
  assert.ok(ds.every((d) => d.kind === 'auto' && d.payload.op === 'note_auto' && /반영할까요/.test(d.summary[0])));
  const sheet = renderSheet({ vault: tmp('v-'), week: '2026-W41', tri, aud: emptyAud, events: [], descriptors: ds, dryRun: false, nowIso: 'x' });
  assert.match(sheet, /### b — 자동 적용 후보/);
  assert.equal((sheet.match(/\[T b\d+\]/g) || []).length, 15);

  const ctx = testCtx();
  ensureSkeleton(ctx.vault);
  const { proposal } = createProposal(ctx.vault, ds[0]);
  decide(ctx.vault, proposal.id, 'approved');
  const r = await apply(ctx);
  assert.equal(r.prompts.length, 1);
  assert.ok(fs.existsSync(atticPath(ctx.vault, 'approved', `${proposal.id}.prompt.md`)));
  assert.equal(getProposal(ctx.vault, proposal.id).status, 'approved', 'not applied automatically');
  assert.ok(!fs.existsSync(atticPath(ctx.vault, 'teach', 'queue.json')));
});

test('[6] README (both) describe b as sheet list + note_auto prompt-only', () => {
  for (const f of ['README.md', 'README.ko.md']) {
    const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(s, /note_auto/, f);
    assert.match(s, /--fresh\]/, f);
  }
});

// ---------------------------------------------------------------- [7]

function reviewCtx(mode) {
  const ctx = testCtx({ env: fakeLlmEnv(mode), config: { triage: { include: ['Refs'], weeklyMinutes: 180 }, llm: { runner: 'claude', model: null, timeoutMs: 20000 } } });
  ensureSkeleton(ctx.vault);
  const inbox = ['# Inbox', ''];
  for (let i = 1; i <= 3; i++) inbox.push(`### [Item ${i}](https://e.test/${i})`, '- source: Feed', `> s ${i}`, '');
  fs.writeFileSync(atticPath(ctx.vault, 'inbox', '2026-10-06.md'), inbox.join('\n'));
  fs.mkdirSync(path.join(ctx.vault, 'Refs'));
  return ctx;
}
const NOW = new Date('2026-10-07T12:00:00');

test('[7] review re-classifies when the saved triage had runner errors, then keeps it once clean', async () => {
  const ctx = reviewCtx('broken');
  const week = isoWeek(NOW);
  const r1 = await review(ctx, { dryRun: true, now: NOW });
  assert.equal(r1.counts.unclassified, 3);
  ctx.env.FAKE_LLM_MODE = 'ok'; // the runner recovered
  const r2 = await review(ctx, { dryRun: true, now: NOW });
  assert.equal(r2.counts.unclassified, 0, 'the failed classification must not be reused');
  const old = new Date(NOW.getTime() - 3600000); // the test clock is fixed; make the inputs older than the saved triage
  fs.utimesSync(atticPath(ctx.vault, 'inbox', '2026-10-06.md'), old, old);
  ctx.env.FAKE_LLM_MODE = 'broken';
  const r3 = await review(ctx, { dryRun: true, now: NOW });
  assert.equal(r3.counts.unclassified, 0, 'a clean saved result is reused');
  assert.ok(fs.existsSync(atticPath(ctx.vault, 'triage', `${week}.json`)));
});

test('[7] triageIsStale: empty items, or inbox / included notes changed after generatedAt', () => {
  const ctx = reviewCtx('ok');
  const t0 = new Date('2026-10-07T12:00:00');
  const fresh = { items: [{ id: 'i1' }], errors: [], generatedAt: new Date(t0.getTime() + 60000).toISOString() };
  const past = new Date(t0.getTime()); // files older than generatedAt
  fs.utimesSync(atticPath(ctx.vault, 'inbox', '2026-10-06.md'), past, past);
  assert.equal(triageIsStale(ctx, ctx.vault, fresh), false);
  assert.equal(triageIsStale(ctx, ctx.vault, { ...fresh, items: [] }), true);
  assert.equal(triageIsStale(ctx, ctx.vault, { ...fresh, errors: ['x'] }), true);
  const later = new Date(t0.getTime() + 3600000);
  fs.utimesSync(atticPath(ctx.vault, 'inbox', '2026-10-06.md'), later, later);
  assert.equal(triageIsStale(ctx, ctx.vault, fresh), true, 'inbox changed after');
  fs.utimesSync(atticPath(ctx.vault, 'inbox', '2026-10-06.md'), past, past);
  fs.writeFileSync(path.join(ctx.vault, 'Refs', 'new.md'), 'x');
  fs.utimesSync(path.join(ctx.vault, 'Refs', 'new.md'), later, later);
  assert.equal(triageIsStale(ctx, ctx.vault, fresh), true, 'included folder changed after');
});

// ---------------------------------------------------------------- [8]

test('[8] plist and cron carry XDG_CONFIG_HOME and the config path (quoted)', async () => {
  const ctx = testCtx();
  ctx.env.XDG_CONFIG_HOME = '/custom & xdg/cfg';
  ctx.configPath = "/custom & xdg/cfg/it's/config.json";
  const extra = configEnvFor(ctx);
  assert.deepEqual(Object.keys(extra).sort(), ['BRAIN_ATTIC_CONFIG', 'XDG_CONFIG_HOME']);
  const plist = renderPlist(JOBS[0], { home: '/home/u', nodePath: '/n/node', binPath: '/a/attic.mjs', extraEnv: extra });
  assert.match(plist, /<key>XDG_CONFIG_HOME<\/key><string>\/custom &amp; xdg\/cfg<\/string>/);
  assert.match(plist, /<key>BRAIN_ATTIC_CONFIG<\/key><string>[^<]*it&apos;s[^<]*<\/string>/);
  const cron = renderCronBlock({ home: '/home/u', nodePath: '/n/node', binPath: '/a/attic.mjs', extraEnv: extra });
  assert.match(cron, /XDG_CONFIG_HOME='\/custom & xdg\/cfg' BRAIN_ATTIC_CONFIG='\/custom & xdg\/cfg\/it'\\''s\/config\.json' '\/n\/node'/);
  const dm = await schedule(ctx, 'install', { dryRun: true, platform: 'darwin' });
  assert.ok(dm.jobs.every((j) => j.plist.includes('<key>BRAIN_ATTIC_CONFIG</key>') && j.plist.includes('<key>XDG_CONFIG_HOME</key>')));
  const lx = await schedule(ctx, 'install', { dryRun: true, platform: 'linux' });
  assert.equal((lx.crontab.match(/BRAIN_ATTIC_CONFIG=/g) || []).length, JOBS.length);
});
