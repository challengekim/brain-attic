import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { testCtx } from './helpers.mjs';
import { JOBS, renderPlist, renderCronBlock, mergeCrontab, stripBlock, schedule, MARK_BEGIN } from '../src/schedule.mjs';

const opt = { home: '/home/u', nodePath: '/opt/node/bin/node', binPath: '/opt/attic/bin/attic.mjs' };

test('plist: label, absolute node + script + command, calendar, logs', () => {
  const radar = renderPlist(JOBS.find((j) => j.name === 'radar'), opt);
  assert.match(radar, /<key>Label<\/key><string>com\.brain-attic\.radar<\/string>/);
  assert.match(radar, /<string>\/opt\/node\/bin\/node<\/string>\s*<string>\/opt\/attic\/bin\/attic\.mjs<\/string>\s*<string>radar<\/string>/);
  assert.match(radar, /<key>Hour<\/key><integer>9<\/integer>\s*<key>Minute<\/key><integer>10<\/integer>/);
  assert.match(radar, /\/home\/u\/Library\/Logs\/brain-attic\/radar\.log/);
  const review = renderPlist(JOBS.find((j) => j.name === 'review'), opt);
  assert.match(review, /<key>Weekday<\/key><integer>1<\/integer>\s*<key>Hour<\/key><integer>8<\/integer>\s*<key>Minute<\/key><integer>30<\/integer>/);
  const retro = renderPlist(JOBS.find((j) => j.name === 'retro'), opt);
  assert.match(retro, /<key>Day<\/key><integer>1<\/integer>\s*<key>Hour<\/key><integer>9<\/integer>\s*<key>Minute<\/key><integer>0<\/integer>/);
});

test('schedule install --dry-run on darwin prints three plists and writes nothing', async () => {
  const ctx = testCtx();
  const r = await schedule(ctx, 'install', { dryRun: true, platform: 'darwin' });
  assert.deepEqual(r.jobs.map((j) => path.basename(j.file)), ['com.brain-attic.radar.plist', 'com.brain-attic.review.plist', 'com.brain-attic.retro.plist']);
  assert.ok(r.jobs.every((j) => j.plist.startsWith('<?xml')));
  assert.ok(!fs.existsSync(path.join(ctx.home, 'Library')), 'dry-run must not touch the home');
});

test('crontab block is marked and merging is idempotent and preserves other lines', () => {
  const block = renderCronBlock(opt);
  assert.match(block, /^# >>> brain-attic >>>/);
  assert.match(block, /10 9 \* \* \* '\/opt\/node\/bin\/node' '\/opt\/attic\/bin\/attic\.mjs' radar/);
  assert.match(block, /30 8 \* \* 1 .* review/);
  assert.match(block, /0 9 1 \* \* .* retro/);
  const existing = '0 1 * * * backup.sh\n';
  const once = mergeCrontab(existing, block);
  const twice = mergeCrontab(once, block);
  assert.equal(once, twice);
  assert.ok(once.startsWith('0 1 * * * backup.sh\n'));
  assert.equal((once.match(new RegExp(MARK_BEGIN, 'g')) || []).length, 1);
  assert.equal(stripBlock(once), existing);
});

test('linux dry-run returns the crontab text', async () => {
  const r = await schedule(testCtx(), 'install', { dryRun: true, platform: 'linux' });
  assert.match(r.crontab, /brain-attic/);
  const u = await schedule(testCtx(), 'uninstall', { dryRun: true, platform: 'linux' });
  assert.ok(!u.crontab.includes('brain-attic'));
});
