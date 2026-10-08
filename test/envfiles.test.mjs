import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnvFiles, makeCtx } from '../src/config.mjs';

test('envFiles: KEY=VALUE, export prefix, quotes, comments; existing env wins; missing file ignored', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-env-'));
  const f = path.join(d, 'a.env');
  fs.writeFileSync(f, '# c\nexport A_TOKEN="abc"\nB_URL=https://x.example\nC=keep-env\nbad line\n');
  const env = loadEnvFiles([f, path.join(d, 'missing.env')], { C: 'from-env' });
  assert.equal(env.A_TOKEN, 'abc');
  assert.equal(env.B_URL, 'https://x.example');
  assert.equal(env.C, 'from-env');
});

test('makeCtx applies config.envFiles', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'attic-env-'));
  fs.mkdirSync(path.join(d, 'brain-attic'));
  fs.writeFileSync(path.join(d, 'tok.env'), 'ATTIC_T=1\n');
  fs.writeFileSync(path.join(d, 'brain-attic', 'config.json'), JSON.stringify({ envFiles: [path.join(d, 'tok.env')] }));
  const ctx = makeCtx({ env: { XDG_CONFIG_HOME: d, HOME: d } });
  assert.equal(ctx.env.ATTIC_T, '1');
});
