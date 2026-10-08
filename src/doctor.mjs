// attic doctor: what is installed, what each thing is for, and what is disabled without it.
// Executables are detected by scanning PATH (what `command -v` does). Only `--version` is ever run.
import fs from 'node:fs';
import path from 'node:path';
import { run, which } from './util.mjs';

const TOOLS = [
  { id: 'git', bins: ['git'], version: true, purpose: '볼트 버전관리, install.sh 의 clone/pull', off: '볼트 git 연동과 install.sh 업데이트' },
  { id: 'gh', bins: ['gh'], version: true, purpose: 'github-issues 승인 어댑터', off: 'github-issues 알림/승인' },
  { id: 'claude', bins: ['claude'], version: true, purpose: 'LLM 러너(claude -p): triage 분류, teach', off: 'triage 분류(미분류로 남음), teach — 러너를 codex 로 바꾸면 대체 가능' },
  { id: 'codex', bins: ['codex'], version: true, purpose: 'LLM 러너(codex exec) 대안', off: 'codex 러너' },
  { id: 'aws', bins: ['aws'], purpose: '이메일 알림(SES) 전송', off: 'email 알림의 SES 경로' },
  { id: 'railway', bins: ['railway'], purpose: 'Railway 에 올린 봇/크론을 쓰는 경우의 배포 확인', off: '(선택) Railway 연동 확인' },
  { id: 'gws', bins: ['gws'], purpose: 'Gmail 로 이메일 알림(gws gmail +send)', off: 'email 알림의 gws 경로 (aws/sendmail 로 대체)' },
  { id: 'aside', bins: ['aside'], purpose: '로그인이 필요한 페이지 수집(브라우저 자동화)', off: '(선택) 로그인 벽 뒤 수집' },
  { id: 'playwright', bins: ['playwright'], purpose: '브라우저 자동화 대안', off: '(선택) 브라우저 자동화 수집' },
];

async function versionOf(bin, env) {
  const r = await run(bin, ['--version'], { env, timeoutMs: 5000 });
  if (r.code !== 0) return null;
  return (r.stdout || r.stderr).trim().split('\n')[0].slice(0, 80) || null;
}

function macApp(env, names) {
  if (process.platform !== 'darwin') return null;
  for (const n of names) for (const dir of ['/Applications', path.join(env.HOME || '', 'Applications')]) {
    const p = path.join(dir, `${n}.app`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function chromePath(env) {
  if (process.platform === 'darwin') {
    for (const p of ['/Applications/Google Chrome.app', path.join(env.HOME || '', 'Applications/Google Chrome.app')]) if (fs.existsSync(p)) return p;
    return null;
  }
  for (const b of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) { const w = which(b, env); if (w) return w; }
  return null;
}

export async function doctor(ctx) {
  const env = ctx.env;
  const items = [];
  const major = Number(process.versions.node.split('.')[0]);
  items.push({ id: 'node', label: 'node', found: true, ok: major >= 20, version: process.version, path: process.execPath,
    purpose: 'brain-attic 실행 (>= 20 필요)', off: major >= 20 ? '' : '실행 불가: Node 20 이상으로 올리세요' });
  for (const t of TOOLS) {
    let p = null;
    for (const b of t.bins) { p = which(b, env); if (p) break; }
    const version = p && t.version ? await versionOf(p, env) : null;
    items.push({ id: t.id, label: t.id, found: !!p, path: p, version, purpose: t.purpose, off: t.off });
  }
  const vault = ctx.vault;
  const vaultExists = !!vault && fs.existsSync(vault);
  items.push({ id: 'vault', label: 'vault', found: vaultExists, path: vault, purpose: '노트 볼트 (_attic/ 에만 쓴다)', off: '대부분의 명령 — `attic init --vault <path>`' });
  items.push({ id: 'vault-git', label: 'vault git', found: vaultExists && fs.existsSync(path.join(vault, '.git')), path: vault, purpose: '볼트 변경 이력(권장)', off: '(선택) 변경 이력 추적' });
  items.push({ id: 'obsidian', label: 'obsidian', found: vaultExists && fs.existsSync(path.join(vault, '.obsidian')), path: vault ? path.join(vault, '.obsidian') : null, purpose: 'Obsidian 으로 시트/노트 열람 (.obsidian 폴더로 판단)', off: '(선택) Obsidian 에서 열람' });
  const chrome = chromePath(env);
  const gptBrowser = macApp(env, ['ChatGPT Atlas', 'ChatGPT']);
  items.push({ id: 'chatgpt-browser', label: 'ChatGPT (Atlas/앱)', found: !!gptBrowser, path: gptBrowser, purpose: 'GPT 쪽 브라우저 에이전트로 로그인 필요한 페이지 읽기(사람이 직접 실행)', off: '(선택) GPT 브라우저 에이전트' });
  items.push({ id: 'chrome', label: 'Chrome', found: !!chrome, path: chrome, purpose: 'claude-in-chrome 등 브라우저 확장 기반 수집', off: '(선택) 브라우저 확장 기반 수집' });
  const llm = ctx.config.llm?.runner || 'claude';
  const runnerOk = llm === 'none' ? false : !!items.find((i) => i.id === llm)?.found;
  return { ok: major >= 20, runner: { configured: llm, available: runnerOk }, items };
}

export function renderDoctor(r) {
  const L = ['brain-attic doctor', ''];
  for (const i of r.items) {
    L.push(`${i.found ? '[있음]' : '[없음]'} ${i.label}${i.version ? ` (${i.version})` : ''}${i.found && i.path && !['vault', 'vault-git', 'obsidian'].includes(i.id) ? ` — ${i.path}` : ''}`);
    L.push(`        용도: ${i.purpose}`);
    if (!i.found || i.ok === false) L.push(`        없으면: ${i.off}`);
  }
  L.push('', `LLM 러너: ${r.runner.configured} (${r.runner.available ? '사용 가능' : '사용 불가 -> triage 는 미분류로 남습니다'})`);
  return L.join('\n');
}
