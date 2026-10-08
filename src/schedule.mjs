// attic schedule install|uninstall|status. macOS: LaunchAgents. Linux: marked crontab block (idempotent).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, homeDir, run, which } from './util.mjs';

export const JOBS = [
  { name: 'collect', cmd: 'collect', when: { Hour: 8, Minute: 0 }, cron: '0 8 * * *', label: '매일 08:00' },
  { name: 'radar', cmd: 'radar', when: { Hour: 9, Minute: 10 }, cron: '10 9 * * *', label: '매일 09:10' },
  { name: 'review', cmd: 'review', when: { Weekday: 1, Hour: 8, Minute: 30 }, cron: '30 8 * * 1', label: '월요일 08:30' },
  { name: 'retro', cmd: 'retro', when: { Day: 1, Hour: 9, Minute: 0 }, cron: '0 9 1 * *', label: '매월 1일 09:00' },
  // Answers given in the app (decision-api / GitHub Issues) are pulled and approved proposals applied within the hour.
  { name: 'tick', cmd: 'tick', when: { Minute: 20 }, cron: '20 * * * *', label: '매시 20분' },
];
export const MARK_BEGIN = '# >>> brain-attic >>>';
export const MARK_END = '# <<< brain-attic <<<';
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'attic.mjs');

/** XML text escape for plist values. Control characters XML 1.0 cannot carry are refused. */
export const esc = (s) => {
  s = String(s);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s)) throw new Error('plist 에 넣을 수 없는 제어 문자가 경로에 있습니다');
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
};

/**
 * Quote one argument for the crontab command field: POSIX single quotes ("'" -> '\''), and cron's own
 * special character % -> \% (an unescaped % is turned into a newline by cron). Newlines cannot be expressed: refuse.
 */
export function cronQuote(s) {
  s = String(s);
  if (/[\r\n\0]/.test(s)) throw new Error('crontab 에 넣을 수 없는 줄바꿈/NUL 이 경로에 있습니다');
  return `'${s.replace(/'/g, `'\\''`)}'`.replace(/%/g, '\\%');
}
export const labelOf = (job) => `com.brain-attic.${job.name}`;

function envPath(home, nodePath) {
  return [path.dirname(nodePath), '/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local/bin'), '/usr/bin', '/bin'].filter((v, i, a) => a.indexOf(v) === i).join(':');
}

/** Env that must survive into launchd/cron so a job reads the same config as the shell that installed it. */
export function configEnvFor(ctx) {
  const out = {};
  if (ctx.env?.XDG_CONFIG_HOME) out.XDG_CONFIG_HOME = ctx.env.XDG_CONFIG_HOME;
  if (ctx.configPath) out.BRAIN_ATTIC_CONFIG = ctx.configPath;
  return out;
}

export function renderPlist(job, { home, nodePath = process.execPath, binPath = BIN, extraEnv = {} } = {}) {
  const logDir = path.join(home, 'Library/Logs/brain-attic');
  const when = Object.entries(job.when).map(([k, v]) => `    <key>${k}</key><integer>${v}</integer>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${esc(labelOf(job))}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${esc(nodePath)}</string>
    <string>${esc(binPath)}</string>
    <string>${esc(job.cmd)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
${when}
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${esc(home)}</string>
    <key>PATH</key><string>${esc(envPath(home, nodePath))}</string>${Object.entries(extraEnv).map(([k, v]) => `\n    <key>${esc(k)}</key><string>${esc(v)}</string>`).join('')}
  </dict>
  <key>StandardOutPath</key><string>${esc(path.join(logDir, job.name + '.log'))}</string>
  <key>StandardErrorPath</key><string>${esc(path.join(logDir, job.name + '.err.log'))}</string>
  <key>RunAtLoad</key><false/>
</dict>
</plist>
`;
}

export function renderCronBlock({ home, nodePath = process.execPath, binPath = BIN, extraEnv = {} } = {}) {
  const logDir = path.join(home, '.local/state/brain-attic');
  const pathVal = envPath(home, nodePath);
  if (/[\r\n\0]/.test(pathVal)) throw new Error('crontab 에 넣을 수 없는 줄바꿈/NUL 이 경로에 있습니다');
  const lines = [MARK_BEGIN, `PATH=${pathVal}`];
  // Prefix assignments per job line (cron variable lines do not take quoting; `VAR='x' cmd` does).
  const envPrefix = Object.entries(extraEnv).map(([k, v]) => `${k}=${cronQuote(v)} `).join('');
  for (const j of JOBS) lines.push(`${j.cron} ${envPrefix}${cronQuote(nodePath)} ${cronQuote(binPath)} ${j.cmd} >> ${cronQuote(`${logDir}/${j.name}.log`)} 2>&1`);
  lines.push(MARK_END);
  return lines.join('\n');
}
/** Replace (or append) the marked block; everything else is untouched. */
export function mergeCrontab(existing, block) {
  const stripped = stripBlock(existing);
  return (stripped ? stripped.replace(/\n*$/, '\n') : '') + (block ? block + '\n' : '');
}
export function stripBlock(existing) {
  const re = new RegExp(`${MARK_BEGIN}[\\s\\S]*?${MARK_END}\\n?`, 'g');
  return existing.replace(re, '');
}

export async function schedule(ctx, action, { dryRun = false, platform = process.platform } = {}) {
  const home = ctx.home || homeDir(ctx.env);
  const out = [];
  if (platform === 'darwin') {
    const dir = path.join(home, 'Library/LaunchAgents');
    const uid = process.getuid ? process.getuid() : 501;
    for (const job of JOBS) {
      const file = path.join(dir, `${labelOf(job)}.plist`);
      if (action === 'install') {
        const plist = renderPlist(job, { home, extraEnv: configEnvFor(ctx) });
        if (dryRun) { out.push({ job: job.name, file, plist }); continue; }
        ensureDir(dir); ensureDir(path.join(home, 'Library/Logs/brain-attic'));
        fs.writeFileSync(file, plist);
        await run('launchctl', ['bootout', `gui/${uid}/${labelOf(job)}`], { env: ctx.env });
        const r = await run('launchctl', ['bootstrap', `gui/${uid}`, file], { env: ctx.env });
        out.push({ job: job.name, file, loaded: r.code === 0, error: r.code === 0 ? undefined : r.stderr.trim() });
      } else if (action === 'uninstall') {
        if (dryRun) { out.push({ job: job.name, file, wouldRemove: fs.existsSync(file) }); continue; }
        await run('launchctl', ['bootout', `gui/${uid}/${labelOf(job)}`], { env: ctx.env });
        const had = fs.existsSync(file); if (had) fs.rmSync(file);
        out.push({ job: job.name, file, removed: had });
      } else {
        const installed = fs.existsSync(file);
        let loaded = null;
        if (installed && !dryRun) loaded = (await run('launchctl', ['print', `gui/${uid}/${labelOf(job)}`], { env: ctx.env })).code === 0;
        out.push({ job: job.name, file, installed, loaded, when: job.label });
      }
    }
    return { platform, action, dryRun, jobs: out };
  }
  // linux / other: crontab. Same result shape as macOS: { platform, action, dryRun, jobs: [{ job, ... }], ... }.
  if (!dryRun && !which('crontab', ctx.env)) throw new Error('crontab 명령이 없습니다');
  const cur = dryRun && action !== 'status' ? '' : (await run('crontab', ['-l'], { env: ctx.env })).stdout;
  const block = renderCronBlock({ home, extraEnv: configEnvFor(ctx) });
  const present = cur.includes(MARK_BEGIN);
  if (action === 'status') {
    return { platform, action, dryRun, installed: present, jobs: JOBS.map((j) => ({ job: j.name, installed: present, loaded: null, when: j.label })) };
  }
  const next = action === 'install' ? mergeCrontab(cur, block) : stripBlock(cur);
  if (dryRun) {
    return { platform, action, dryRun, crontab: next, jobs: JOBS.map((j) => (action === 'install' ? { job: j.name, when: j.label } : { job: j.name, wouldRemove: present })) };
  }
  ensureDir(path.join(home, '.local/state/brain-attic'));
  const r = await run('crontab', ['-'], { input: next, env: ctx.env });
  if (r.code !== 0) throw new Error(`crontab 설치 실패: ${r.stderr.trim()}`);
  const on = action === 'install';
  return { platform, action, dryRun, installed: on, jobs: JOBS.map((j) => (on ? { job: j.name, installed: true, when: j.label } : { job: j.name, removed: present })) };
}

/** Text the CLI prints for a schedule() result (any platform). */
export function renderScheduleResult(r) {
  if (r.crontab !== undefined) return r.crontab;
  return (r.jobs || []).map((j) => (j.plist ? `# ${j.file}\n${j.plist}` : JSON.stringify(j))).join('\n');
}
