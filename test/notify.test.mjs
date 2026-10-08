import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCtx, startServer, tmp } from './helpers.mjs';
import { adapters } from '../src/notify/simple.mjs';
import { dispatch } from '../src/notify/index.mjs';

const msg = { title: '제목', text: '본문\n둘째 줄' };

test('discord/slack/telegram/ntfy post to the configured endpoint; secrets come from env names', async () => {
  const hits = [];
  const s = await startServer((req, res, body) => { hits.push({ method: req.method, url: req.url, body, headers: req.headers }); res.end('{}'); });
  const ctx = testCtx({ env: { ATTIC_D: `${s.url}/hook/SECRETPATH`, ATTIC_TG: 'tg-token', ATTIC_SL: `${s.url}/slack` } });
  await adapters.discord(ctx, { webhookEnv: 'ATTIC_D' }, msg);
  await adapters.slack(ctx, { webhookEnv: 'ATTIC_SL' }, msg);
  await adapters.telegram(ctx, { tokenEnv: 'ATTIC_TG', chatId: '42', apiBase: s.url }, msg);
  await adapters.ntfy(ctx, { url: `${s.url}/topic` }, msg);
  await s.close();
  assert.equal(hits.length, 4);
  assert.match(JSON.parse(hits[0].body).content, /본문/);
  assert.equal(hits[1].url, '/slack');
  assert.equal(hits[2].url, '/bottg-token/sendMessage');
  assert.equal(JSON.parse(hits[2].body).chat_id, '42');
  assert.equal(hits[3].url, '/topic');
});

test('failures never leak the webhook URL; missing env var is a clear error', async () => {
  const s = await startServer((req, res) => { res.statusCode = 500; res.end('no'); });
  const ctx = testCtx({ env: { ATTIC_D: `${s.url}/hook/SECRETPATH` } });
  await assert.rejects(adapters.discord(ctx, { webhookEnv: 'ATTIC_D' }, msg), (e) => { assert.ok(!e.message.includes('SECRETPATH')); assert.match(e.message, /HTTP 500/); return true; });
  await s.close();
  await assert.rejects(adapters.slack(ctx, { webhookEnv: 'ATTIC_MISSING' }, msg), /ATTIC_MISSING/);
  const r = await dispatch({ ...ctx, config: { ...ctx.config, notifiers: [{ type: 'discord', webhookEnv: 'ATTIC_D' }, { type: 'bogus' }, { type: 'stdout' }] } }, msg);
  assert.deepEqual(r.map((x) => x.ok), [false, false, true]);
  assert.ok(!JSON.stringify(r).includes('SECRETPATH'));
  assert.ok(!ctx.log.lines.join('\n').includes('SECRETPATH'));
});

test('email: uses gws when present, falls back to sendmail, and skips with a warning when nothing exists', async () => {
  const dir = tmp('bin-'); const out = path.join(dir, 'out.txt');
  const script = (name, body) => fs.writeFileSync(path.join(dir, name), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
  script('gws', `require('fs').appendFileSync(${JSON.stringify(out)}, 'gws ' + JSON.stringify(process.argv.slice(2)) + '\\n')`);
  const ctx = testCtx({ env: { PATH: dir } });
  assert.equal((await adapters.email(ctx, { to: 'a@example.com' }, msg)).via, 'gws');
  assert.match(fs.readFileSync(out, 'utf8'), /"\+send","--to","a@example.com"/);
  fs.rmSync(path.join(dir, 'gws'));
  script('sendmail', `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('fs').appendFileSync(${JSON.stringify(out)}, 'sendmail ' + s))`);
  assert.equal((await adapters.email(ctx, { to: 'a@example.com' }, msg)).via, 'sendmail');
  assert.match(fs.readFileSync(out, 'utf8'), /Subject: 제목/);
  fs.rmSync(path.join(dir, 'sendmail'));
  const r = await adapters.email(ctx, { to: 'a@example.com' }, msg);
  assert.equal(r.ok, false);
  assert.ok(ctx.log.lines.some((l) => l.startsWith('WARN') && l.includes('건너뜁니다')));
});
