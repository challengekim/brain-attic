import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { DEFAULTS } from '../src/config.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FAKE_LLM = path.join(ROOT, 'test', 'fixtures', 'fake-llm.mjs');

export function tmp(prefix = 'attic-') { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

export function silentLog() {
  const lines = [];
  return { lines, info: (...a) => lines.push(a.join(' ')), warn: (...a) => lines.push('WARN ' + a.join(' ')) };
}

/** A ctx that never touches the real home. */
export function testCtx({ config = {}, fetch, env = {}, vault } = {}) {
  const home = tmp('attic-home-');
  const v = vault || path.join(home, 'vault');
  fs.mkdirSync(v, { recursive: true });
  const merged = { ...DEFAULTS, ...config, vault: v };
  const fullEnv = { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg'), ...env };
  return { env: fullEnv, home, configPath: path.join(home, 'xdg', 'brain-attic', 'config.json'), config: merged, vault: v, fetch, log: silentLog() };
}
export const fakeLlmEnv = (mode = 'ok') => ({ BRAIN_ATTIC_LLM_CMD: `${process.execPath} ${FAKE_LLM}`, FAKE_LLM_MODE: mode });

export function response(body, { status = 200 } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status });
}
/** fetch stub: routes by URL substring -> body|function|Error */
export function routeFetch(routes, calls = []) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [k, v] of Object.entries(routes)) {
      if (String(url).includes(k)) {
        const r = typeof v === 'function' ? await v(url, init) : v;
        if (r instanceof Error) throw r;
        return r instanceof Response ? r : response(r);
      }
    }
    return response('not found', { status: 404 });
  };
}

export function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let body = ''; for await (const c of req) body += c;
      handler(req, res, body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
  });
}
