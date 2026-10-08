import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmp, ROOT } from './helpers.mjs';
import { configPath, loadConfig, expandHome } from '../src/config.mjs';

const attic = (args, env) => spawnSync(process.execPath, [path.join(ROOT, 'bin/attic.mjs'), ...args], { env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' });

test('configPath honours XDG_CONFIG_HOME, else ~/.config', () => {
  assert.equal(configPath({ XDG_CONFIG_HOME: '/x', HOME: '/h' }), '/x/brain-attic/config.json');
  assert.equal(configPath({ HOME: '/h' }), '/h/.config/brain-attic/config.json');
  assert.equal(expandHome('~/n', { HOME: '/h' }), '/h/n');
});

test('init creates config, skeleton, templates and is idempotent', () => {
  const home = tmp(); const vault = path.join(home, 'v'); const xdg = path.join(home, 'xdg');
  const env = { HOME: home, XDG_CONFIG_HOME: xdg };
  const r1 = attic(['init', '--vault', vault, '--yes'], env);
  assert.equal(r1.status, 0, r1.stderr);
  const cfgFile = path.join(xdg, 'brain-attic', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.equal(cfg.vault, vault);
  assert.ok(cfg.sources.length >= 5);
  for (const d of ['inbox', 'state', 'radar', 'proposals', 'reviews', 'retro']) assert.ok(fs.statSync(path.join(vault, '_attic', d)).isDirectory(), d);
  const projects = path.join(vault, '_attic', 'projects.md');
  assert.ok(fs.existsSync(projects));
  fs.writeFileSync(projects, '- 내 일 — 한 문장 — 막힘\n');
  cfg.sources = []; fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  const r2 = attic(['init', '--vault', vault, '--yes'], env);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(fs.readFileSync(projects, 'utf8'), '- 내 일 — 한 문장 — 막힘\n', 'templates must not overwrite');
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')).sources, [], 'existing config is kept');
});

test('init symlinks skills only where the tool dir exists, and skips existing', () => {
  const home = tmp(); const vault = path.join(home, 'v');
  fs.mkdirSync(path.join(home, '.claude'));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
  const r = attic(['init', '--vault', vault, '--yes'], env);
  assert.equal(r.status, 0, r.stderr);
  const link = path.join(home, '.claude', 'skills', 'attic-review');
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(ROOT, 'skills', 'attic-review')));
  assert.ok(!fs.existsSync(path.join(home, '.codex')), '.codex must not be created');
  const r2 = attic(['init', '--yes'], env);
  assert.match(r2.stdout, /이미 있음, 건너뜀/);
});

test('init without vault and without --yes (non-tty) fails clearly', () => {
  const home = tmp();
  const r = attic(['init'], { HOME: home, XDG_CONFIG_HOME: path.join(home, 'x') });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /볼트 경로/);
});

test('loadConfig merges defaults', () => {
  const home = tmp(); const f = path.join(home, 'c.json');
  fs.writeFileSync(f, JSON.stringify({ triage: { weeklyMinutes: 60 } }));
  const c = loadConfig({}, f);
  assert.equal(c.triage.weeklyMinutes, 60);
  assert.deepEqual(c.triage.include, []);
  assert.equal(c.llm.runner, 'claude');
});
