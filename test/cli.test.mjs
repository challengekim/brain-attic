import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmp, ROOT } from './helpers.mjs';

const home = tmp();
const env = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
const attic = (args, extra = {}) => spawnSync(process.execPath, [path.join(ROOT, 'bin/attic.mjs'), ...args], { env: { ...env, ...extra }, encoding: 'utf8' });

test('every command supports --help (exit 0, non-empty)', () => {
  for (const c of ['init', 'doctor', 'collect', 'save', 'radar', 'triage', 'audit', 'review', 'approve', 'reject', 'pending', 'sync', 'apply', 'retro', 'schedule', 'teach']) {
    const r = attic([c, '--help']);
    assert.equal(r.status, 0, c);
    assert.match(r.stdout, /사용법/, c);
  }
  assert.equal(attic(['--help']).status, 0);
  assert.equal(attic(['nope']).status, 2);
});

test('doctor --json is valid JSON and works with an empty HOME and no config', () => {
  const r = attic(['doctor', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.ok, true);
  const ids = j.items.map((i) => i.id);
  for (const id of ['node', 'git', 'gh', 'claude', 'codex', 'aws', 'railway', 'gws', 'aside', 'playwright', 'chrome', 'vault', 'obsidian']) assert.ok(ids.includes(id), id);
  assert.ok(j.items.every((i) => typeof i.purpose === 'string' && typeof i.found === 'boolean'));
});

test('doctor detects an executable only via PATH and a vault .obsidian folder', () => {
  const bin = tmp('bin-'); fs.writeFileSync(path.join(bin, 'aside'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const vault = tmp('vault-'); fs.mkdirSync(path.join(vault, '.obsidian'));
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'brain-attic'), { recursive: true });
  fs.writeFileSync(path.join(env.XDG_CONFIG_HOME, 'brain-attic', 'config.json'), JSON.stringify({ vault }));
  const j = JSON.parse(attic(['doctor', '--json'], { PATH: `${bin}:${process.env.PATH}` }).stdout);
  assert.equal(j.items.find((i) => i.id === 'aside').found, true);
  assert.equal(j.items.find((i) => i.id === 'obsidian').found, true);
  assert.equal(j.items.find((i) => i.id === 'vault').found, true);
});

test('approve / reject / pending drive the proposal store from the CLI', async () => {
  const { createProposal, getProposal } = await import('../src/proposals.mjs');
  const vault = JSON.parse(fs.readFileSync(path.join(env.XDG_CONFIG_HOME, 'brain-attic', 'config.json'), 'utf8')).vault;
  const a = createProposal(vault, { kind: 'x', summary: ['첫 제안'], payload: { op: 'x', n: 1 } }).proposal;
  const b = createProposal(vault, { kind: 'x', summary: ['둘째 제안'], payload: { op: 'x', n: 2 } }).proposal;
  assert.match(attic(['pending']).stdout, new RegExp(a.id));
  assert.match(attic(['approve', a.id]).stdout, /approved/);
  assert.match(attic(['reject', b.id]).stdout, /rejected/);
  assert.equal(getProposal(vault, a.id).status, 'approved');
  assert.match(attic(['pending']).stdout, /대기 중인 제안이 없습니다/);
  assert.notEqual(attic(['approve', 'attic-doesnotexist']).status, 0);
});

test('teach delegates to src/teach.mjs (module presence is the only coupling)', () => {
  const r = attic(['teach', '--help']);
  assert.equal(r.status, 0);
});
