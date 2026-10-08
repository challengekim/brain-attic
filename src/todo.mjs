// Approved try_in_project proposals -> one outside task (config.todo), e.g. a to-do app's CLI.
//   config.todo = { "argv": ["lcc-task.py", "{title}", "--due", "{due}", "--body", "{body}", "--tags", "{tags}"],
//                   "dueDays": 3, "timeoutMs": 30000 }
// The command runs without a shell; placeholders are replaced inside single arguments only.
// Exit contract: 0 = the task was created. 75 (EX_TEMPFAIL) = definitely NOT created, safe to retry.
// Anything else (other exit codes, timeout, signal) = unknown: the task may exist, so attic never retries by itself;
// `attic todo` lists these and `attic todo resolve <id> --delivered|--retry` closes them after a human looked.
// A lock file (_attic/state/todo/<id>.lock, created with O_EXCL) is taken before ANY write for that proposal, so two
// `apply` runs (the hourly tick and a manual one) can never both deliver, or overwrite each other's record.
import fs from 'node:fs';
import path from 'node:path';
import { atticMkdir, atticPath, atticWritePath, writeAttic } from './vault.mjs';
import { getProposal, isApplicable, listProposals, saveProposal } from './proposals.mjs';
import { dateStr, homeDir, run, truncate, which } from './util.mjs';

export const EX_TEMPFAIL = 75;
export const DEFAULT_DUE_DAYS = 3;
const LOCK_DIR = 'state/todo';
const lockRel = (id) => `${LOCK_DIR}/${id}.lock`;

/** Valid config.todo or null. argv: non-empty strings, the first one is the command. */
export function todoConfig(ctx) {
  const t = ctx.config.todo;
  if (!t || !Array.isArray(t.argv) || !t.argv.length || !t.argv.every((a) => typeof a === 'string' && a.length)) return null;
  const n = (v, d, lo, hi) => (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi ? Number(v) : d);
  return { argv: t.argv, dueDays: n(t.dueDays, DEFAULT_DUE_DAYS, 0, 60), timeoutMs: n(t.timeoutMs, 30000, 1000, 300000) };
}

/** Absolute path of the command, or null when it cannot be run at all (then nothing was created: safe to retry). */
export function resolveCommand(cmd, env) {
  const home = homeDir(env);
  const c = cmd.startsWith('~/') ? path.join(home, cmd.slice(2)) : cmd;
  if (c.includes('/')) {
    try { fs.accessSync(c, fs.constants.X_OK); return fs.statSync(c).isFile() ? c : null; } catch { return null; }
  }
  return which(c, env);
}

export function promptRel(id) { return `approved/${id}.prompt.md`; }

/** The instruction file for a try proposal: small, measured, reversible, written back to the vault. */
export function tryPrompt(p) {
  const x = p.payload;
  const source = x.url || (x.file ? `볼트 노트 ${x.file}` : '(없음)');
  return [
    `# 해 볼 것 — ${x.title} (${x.project})`, '',
    `> attic 제안 ${p.id}. 사람이 승인했고, 아직 실행되지 않았습니다.`, '',
    '## 무엇을', `- 다음 행동: ${x.next}`, `- 판정: ${x.check}`, `- 이유: ${x.reason || ''}`, `- 원문: ${source}`, '',
    '## 진행 규칙',
    `- ${x.project} 에서만, 되돌리기 쉬운 범위로 시도합니다(그 세션에만 붙이는 설정·별도 브랜치). 전역 설정 변경이나 상시 등록은 하지 않습니다.`,
    '- 시도하기 전에 «판정» 에 쓸 값을 먼저 잽니다(전). 시도한 뒤 같은 방법으로 다시 잽니다(후).',
    '- 결과는 볼트에 남깁니다: 전/후 값, 판정(됐다/안 됐다), 계속 쓸지. 원문 노트가 있으면 그 노트 아래 «시험 결과» 절로.',
    '- 판정이 «안 됐다» 면 바꾼 것을 되돌립니다.', '',
    '실행 예: `claude -p < ' + `_attic/${promptRel(p.id)}` + '`', '',
  ].join('\n');
}

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/**
 * argv with placeholders filled. When an argument STARTS with a placeholder and the filled value starts with "-", it gets
 * a leading "·" so model-written text cannot become an option. Option prefixes written in the config (--title={title})
 * are the user's and stay as they are.
 */
export function renderTodoArgv(cfg, p, { vault, now = new Date() } = {}) {
  const x = p.payload;
  const decided = Number.isFinite(Date.parse(p.decidedAt)) ? new Date(p.decidedAt) : now;
  let due = addDays(decided, cfg.dueDays);
  if (due < addDays(now, 0)) due = addDays(now, 0); // delivered late: never a due date in the past
  const values = {
    title: truncate(`[attic] ${x.project}: ${x.title}`.replace(/\s+/g, ' '), 120),
    body: [
      `다음 행동: ${x.next}`, `판정: ${x.check}`, x.reason ? `이유: ${x.reason}` : '',
      `원문: ${x.url || (x.file ? x.file : '(없음)')}`,
      vault ? `지시문: ${atticPath(vault, promptRel(p.id))}` : '',
      `attic:${p.id}`,
    ].filter(Boolean).join('\n'),
    due: dateStr(due), tags: ['attic', x.project].filter(Boolean).join(','), project: x.project || '', id: p.id, url: x.url || '',
  };
  return cfg.argv.map((a, i) => {
    if (i === 0 || !/\{(title|body|due|tags|project|id|url)\}/.test(a)) return a;
    const v = a.replace(/\{(title|body|due|tags|project|id|url)\}/g, (_, k) => values[k]);
    return a.startsWith('{') && v.startsWith('-') ? `·${v}` : v;
  });
}

function takeLock(vault, id) {
  atticMkdir(vault, LOCK_DIR);
  let fd;
  try { fd = fs.openSync(atticWritePath(vault, lockRel(id)), 'wx'); }
  catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); } // owner, so resolve can tell a live delivery
  return true;
}
/** True while the process that took the lock is still running (a delivery in progress, not an abandoned one). */
export function lockOwnerAlive(vault, id) {
  let pid;
  try { pid = Number(fs.readFileSync(atticPath(vault, lockRel(id)), 'utf8').trim()); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function dropLock(vault, id) { try { fs.unlinkSync(atticWritePath(vault, lockRel(id))); } catch { /* gone */ } }
export function isLocked(vault, id) { return fs.existsSync(atticPath(vault, lockRel(id))); }

/**
 * One approved try proposal: prompt file, then (if config.todo) one delivery attempt.
 * Returns { applied } | { prompt } | { skipped } | { error, uncertain? }.
 */
export async function applyTry(ctx, vault, id, now = new Date()) {
  if (!takeLock(vault, id)) return { skipped: '할일 배달 중이거나 결과 불명입니다 — `attic todo` 로 확인하세요' };
  let keepLock = false;
  try {
    // Re-read under the lock: what the caller loaded may already be stale.
    const p = getProposal(vault, id);
    if (!p || !isApplicable(p)) return { skipped: '승인 상태가 아닙니다' };
    const rel = promptRel(p.id);
    if (!fs.existsSync(atticPath(vault, rel))) writeAttic(vault, rel, tryPrompt(p));
    if (p.promptFile !== rel) { p.promptFile = rel; saveProposal(vault, p); }
    const cfg = todoConfig(ctx);
    // No task hook: the instruction file is ready; the proposal stays approved so a hook configured later still delivers.
    if (!cfg) return { prompt: atticPath(vault, rel) };
    if (p.todo?.state === 'delivered') {
      p.status = 'applied'; p.appliedAt = p.appliedAt || now.toISOString(); saveProposal(vault, p);
      return { applied: true };
    }
    const cmd = resolveCommand(cfg.argv[0], ctx.env);
    if (!cmd) return { error: `할일 명령을 찾지 못했습니다: ${cfg.argv[0]} — 다음 실행에 다시 시도합니다` };
    const argv = renderTodoArgv(cfg, p, { vault, now });
    p.todo = { state: 'delivering', at: now.toISOString() };
    saveProposal(vault, p);
    keepLock = true; // from here a crash leaves the lock: the task may exist, a human decides (attic todo)
    const r = await run(cmd, argv.slice(1), { env: ctx.env, timeoutMs: cfg.timeoutMs });
    const tail = truncate(`${r.stderr || ''}${r.stdout || ''}`.trim(), 300);
    if (r.code === 0 && !r.timedOut) {
      p.todo = { state: 'delivered', at: new Date().toISOString(), ...(tail ? { output: tail } : {}) };
      p.status = 'applied'; p.appliedAt = now.toISOString(); saveProposal(vault, p);
      keepLock = false;
      return { applied: true };
    }
    if (r.code === EX_TEMPFAIL && !r.timedOut) {
      delete p.todo; saveProposal(vault, p);
      keepLock = false;
      return { error: `할일 명령이 만들지 못했다고 알렸습니다(exit ${EX_TEMPFAIL}) — 다음 실행에 다시 시도합니다${tail ? `: ${tail}` : ''}` };
    }
    p.todo = { state: 'uncertain', at: new Date().toISOString(), exit: r.code, ...(r.timedOut ? { timedOut: true } : {}), ...(tail ? { error: tail } : {}) };
    saveProposal(vault, p);
    return { error: `할일이 만들어졌는지 알 수 없습니다(${r.timedOut ? '시간 초과' : `exit ${r.code}`}) — 앱에서 «attic:${p.id}» 를 찾아본 뒤 \`attic todo resolve ${p.id} --delivered\` 또는 \`--retry\``, uncertain: true };
  } finally {
    if (!keepLock) dropLock(vault, id);
  }
}

/** Proposals whose delivery needs a human: started but never finished (crash), or finished with an unknown result. */
export function todoStatus(vault) {
  return listProposals(vault)
    .filter((p) => p.payload?.op === 'try_in_project' && (['delivering', 'uncertain'].includes(p.todo?.state) || isLocked(vault, p.id)))
    .map((p) => ({ id: p.id, title: p.payload.title, project: p.payload.project, state: p.todo?.state || 'locked', at: p.todo?.at || null, ...(p.todo?.error ? { error: p.todo.error } : {}) }));
}

/** delivered: the task exists (close it). retry: it does not (clear the record and the lock; the next apply delivers). */
export function resolveTodo(vault, id, how, now = new Date()) {
  const p = getProposal(vault, id);
  if (!p || p.payload?.op !== 'try_in_project') throw new Error(`해 볼 것 제안이 아닙니다: ${id}`);
  // A delivery still running may yet create the task: never unlock it from under the running process.
  if (p.todo?.state !== 'uncertain' && lockOwnerAlive(vault, id)) throw new Error(`${id}: 배달이 아직 진행 중입니다 — 끝난 뒤 다시 확인하세요`);
  if (how === 'delivered') {
    p.todo = { ...p.todo, state: 'delivered', resolvedAt: now.toISOString(), resolvedBy: 'cli' };
    if (p.status === 'approved') { p.status = 'applied'; p.appliedAt = now.toISOString(); }
  } else if (how === 'retry') {
    if (p.todo?.state === 'delivered') throw new Error(`${id}: 이미 배달됐습니다`);
    delete p.todo;
  } else throw new Error(`--delivered 또는 --retry 중 하나를 고르세요`);
  saveProposal(vault, p);
  dropLock(vault, id);
  return p;
}
