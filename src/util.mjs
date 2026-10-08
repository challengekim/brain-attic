// Small shared helpers. Node built-ins only.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const pad = (n) => String(n).padStart(2, '0');
export function dateStr(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function timeStr(d = new Date()) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** ISO week label like 2026-W41 (local time). */
export function isoWeek(d = new Date()) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7);
  return `${y}-W${pad(w)}`;
}
/** Monday 00:00 (local) of a YYYY-Www label. */
export function weekStart(label) {
  const m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (!m) throw new Error(`잘못된 주 형식: ${label} (YYYY-Www)`);
  const jan4 = new Date(Number(m[1]), 0, 4);
  const day = jan4.getDay() || 7;
  const mon = new Date(jan4);
  mon.setDate(jan4.getDate() - day + 1 + (Number(m[2]) - 1) * 7);
  mon.setHours(0, 0, 0, 0);
  return mon;
}
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

export function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); return p; }
export function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
export function writeFileAtomic(p, data) {
  ensureDir(path.dirname(p));
  // Exclusive create with an unpredictable name: a pre-planted symlink at the temp path cannot redirect
  // the write ('wx' fails on any existing path, including a symlink). Retry on the rare collision.
  for (let attempt = 0; ; attempt++) {
    const tmp = `${p}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    let fd;
    try { fd = fs.openSync(tmp, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST' && attempt < 5) continue; throw e; }
    try { fs.writeFileSync(fd, data); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, p);
    return;
  }
}
export const writeJson = (p, obj) => writeFileAtomic(p, JSON.stringify(obj, null, 2) + '\n');

export function homeDir(env = process.env) { return env.HOME || os.homedir(); }

/** Find an executable on PATH (what `command -v` does). No subprocess is started. */
export function which(name, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT || '.EXE;.CMD').split(';') : [''];
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      try {
        if (fs.statSync(p).isFile()) { fs.accessSync(p, fs.constants.X_OK); return p; }
      } catch { /* next */ }
    }
  }
  return null;
}

/** Run argv (no shell). Resolves {code, stdout, stderr, timedOut}; never rejects on non-zero exit. */
export function run(cmd, args = [], { input, timeoutMs = 30000, env = process.env, cwd } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, stdout: '', stderr: String(e.message), timedOut: false }); }
    let stdout = '', stderr = '', timedOut = false, done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (e) => finish({ code: -1, stdout, stderr: stderr + String(e.message), timedOut }));
    child.on('close', (code) => finish({ code: code ?? -1, stdout, stderr, timedOut }));
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

/** Drop utm_* etc., fragment, trailing slash. */
export function normalizeUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return String(raw).trim().replace(/\/+$/, ''); }
  u.hash = '';
  u.hostname = u.hostname.toLowerCase();
  for (const k of [...u.searchParams.keys()]) {
    if (/^utm_/i.test(k) || ['fbclid', 'gclid', 'mc_cid', 'mc_eid', 'ref_src'].includes(k.toLowerCase())) u.searchParams.delete(k);
  }
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, '');
  let s = u.toString();
  if (u.pathname === '/' && !u.search) s = s.replace(/\/$/, '');
  return s;
}

/** Replace anything URL-shaped so error text never leaks tokens that live in URL paths/queries. */
export function redactUrls(s) { return String(s ?? '').replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]'); }

/** Errors never contain the URL (tokens may sit in the path). `source` is a caller-chosen display name. */
export async function fetchText(ctx, url, { timeoutMs = 20000, headers = {}, method = 'GET', body, source } = {}) {
  const f = ctx.fetch || globalThis.fetch;
  const who = source ? ` (${source})` : '';
  let res, text;
  try {
    res = await f(url, {
      method, body,
      headers: { 'user-agent': 'brain-attic/0.1 (+https://github.com/challengekim/brain-attic)', ...headers },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    text = await res.text();
  } catch (e) {
    const err = new Error(`요청 실패${who}: ${e?.name === 'TimeoutError' ? '시간 초과' : '네트워크 오류'}`);
    throw err;
  }
  if (!res.ok) { const e = new Error(`HTTP ${res.status}${who}`); e.status = res.status; e.body = text; throw e; }
  return text;
}

export function parseArgs(argv, { bool = [], string = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split(/=(.*)/s);
      if (v !== undefined) out[k] = v;
      else if (bool.includes(k) || !string.includes(k)) out[k] = true;
      else out[k] = argv[++i];
    } else out._.push(a);
  }
  return out;
}

export function truncate(s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
