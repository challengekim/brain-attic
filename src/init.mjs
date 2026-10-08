// attic init: config + vault skeleton + templates + skill symlinks. Idempotent; never overwrites.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { configExists, expandHome, loadConfig, saveConfig } from './config.mjs';
import { atticPath, atticMkdir, copyIntoAttic, ensureSkeleton } from './vault.mjs';
import { ensureDir, readJson } from './util.mjs';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Copy template files into <vault>/_attic/<rel> through the vault write gate; never overwrites. */
function copyMissing(vault, rel, src, notes) {
  atticMkdir(vault, rel);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) copyMissing(vault, r, s, notes);
    else if (copyIntoAttic(vault, r, s)) notes.push(`복사: ${atticPath(vault, r)}`);
    else notes.push(`이미 있음, 덮지 않음: ${atticPath(vault, r)}`);
  }
}

function linkSkills(ctx, notes) {
  const skillsDir = path.join(REPO_ROOT, 'skills');
  if (!fs.existsSync(skillsDir)) return;
  const names = fs.readdirSync(skillsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  for (const tool of ['.claude', '.codex']) {
    const base = path.join(ctx.home, tool);
    if (!fs.existsSync(base)) { notes.push(`${base} 없음 -> ${tool} 스킬 연결 건너뜀`); continue; }
    const dest = path.join(base, 'skills');
    ensureDir(dest);
    for (const n of names) {
      const link = path.join(dest, n);
      let exists = false;
      try { fs.lstatSync(link); exists = true; } catch { /* free */ }
      if (exists) { notes.push(`이미 있음, 건너뜀: ${link}`); continue; }
      fs.symlinkSync(path.join(skillsDir, n), link, 'dir');
      notes.push(`심링크: ${link} -> ${path.join(skillsDir, n)}`);
    }
  }
}

export async function init(ctx, { vault, yes = false, input = process.stdin, output = process.stdout } = {}) {
  const notes = [];
  const had = configExists(ctx.env, ctx.configPath);
  const config = loadConfig(ctx.env, ctx.configPath);
  let chosen = vault || config.vault;
  if (!chosen) {
    if (yes) chosen = '~/notes';
    else if (input.isTTY) {
      const rl = readline.createInterface({ input, output });
      const a = (await rl.question('볼트 경로 (Enter = ~/notes): ')).trim();
      rl.close();
      chosen = a || '~/notes';
    } else throw new Error('볼트 경로가 필요합니다: attic init --vault <path> (또는 --yes 로 ~/notes 사용)');
  }
  config.vault = vault ? vault : chosen; // keep "~" form when the user typed it
  const vaultAbs = path.resolve(expandHome(config.vault, ctx.env));
  if (!had) {
    const ex = readJson(path.join(REPO_ROOT, 'templates', 'sources.example.json'), []);
    if (!config.sources.length) config.sources = ex;
    notes.push(`config 생성: ${ctx.configPath} (예시 출처 ${config.sources.length}개 포함 — 마음에 안 들면 지우세요)`);
  } else notes.push(`config 유지: ${ctx.configPath}${vault ? ' (vault 만 갱신)' : ''}`);
  saveConfig(config, ctx.env, ctx.configPath);
  ensureDir(vaultAbs);
  ensureSkeleton(vaultAbs);
  copyMissing(vaultAbs, '', path.join(REPO_ROOT, 'templates', 'vault', '_attic'), notes);
  const rules = path.join(REPO_ROOT, 'templates', 'rules'); // written separately; copied when present
  if (fs.existsSync(rules)) copyMissing(vaultAbs, 'rules', rules, notes);
  linkSkills(ctx, notes);
  return { vault: vaultAbs, configPath: ctx.configPath, notes };
}
