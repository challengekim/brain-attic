// Config: $XDG_CONFIG_HOME/brain-attic/config.json (fallback ~/.config/brain-attic/config.json).
// Secrets are never stored here -- only the NAME of an environment variable ("webhookEnv": "ATTIC_DISCORD_WEBHOOK").
import fs from 'node:fs';
import path from 'node:path';
import { homeDir, readJson, writeJson } from './util.mjs';

export const DEFAULTS = {
  vault: null,
  projectsFile: null,
  sources: [],
  llm: { runner: 'claude', model: null, timeoutMs: 180000 },
  triage: { include: [], weeklyMinutes: 180 },
  audit: { paths: [] },
  radar: { openrouterUrl: 'https://openrouter.ai/api/v1/models', kieLlmsUrl: 'https://docs.kie.ai/llms.txt', priceThreshold: 0.2 },
  notifiers: [{ type: 'stdout' }],
};

export function configPath(env = process.env) {
  if (env.BRAIN_ATTIC_CONFIG) return env.BRAIN_ATTIC_CONFIG; // pinned by `attic schedule install`
  const base = env.XDG_CONFIG_HOME || path.join(homeDir(env), '.config');
  return path.join(base, 'brain-attic', 'config.json');
}

export function expandHome(p, env = process.env) {
  if (typeof p !== 'string') return p;
  if (p === '~') return homeDir(env);
  if (p.startsWith('~/')) return path.join(homeDir(env), p.slice(2));
  return p;
}

function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])
      ? merge(base[k], v) : v;
  }
  return out;
}

export function loadConfig(env = process.env, file = configPath(env)) {
  const raw = readJson(file, null);
  return merge(DEFAULTS, raw || {});
}
export function configExists(env = process.env, file = configPath(env)) { return fs.existsSync(file); }
export function saveConfig(config, env = process.env, file = configPath(env)) { writeJson(file, config); }

export function resolveVault(config, env = process.env, override) {
  const v = override || config.vault;
  return v ? path.resolve(expandHome(v, env)) : null;
}

/** Build the context every command gets. */
/**
 * Read KEY=VALUE lines from env files listed in config.envFiles (e.g. a chmod 600 file that already holds a
 * webhook or API token for other jobs). Values never go into config.json. Existing env vars win.
 */
export function loadEnvFiles(files, env) {
  const out = { ...env };
  for (const f of files || []) {
    const p = expandHome(f, env);
    let text;
    try { text = fs.readFileSync(p, 'utf8'); } catch { continue; }
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!m || out[m[1]] !== undefined) continue;
      out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return out;
}

export function makeCtx({ env: baseEnv = process.env, vaultOverride, fetch, log } = {}) {
  const file = configPath(baseEnv);
  const config = loadConfig(baseEnv, file);
  const env = loadEnvFiles(config.envFiles, baseEnv);
  const vault = resolveVault(config, env, vaultOverride);
  const logger = log || {
    info: (...a) => console.log(...a),
    warn: (...a) => console.error(...a),
  };
  return { env, home: homeDir(env), configPath: file, config, vault, fetch: fetch || globalThis.fetch, log: logger };
}

export function requireVault(ctx) {
  if (!ctx.vault) throw new Error('볼트 경로가 없습니다. `attic init --vault <path>` 를 먼저 실행하세요.');
  return ctx.vault;
}

export function getSecret(ctx, envName) {
  if (!envName) return null;
  const v = ctx.env[envName];
  return v ? v : null;
}
