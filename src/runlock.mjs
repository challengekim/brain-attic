// One proposal-changing run at a time per vault: review, retro, tick, sync, apply.
// review classifies, deduplicates and withdraws cards before it announces them; tick re-sends announced cards that did
// not reach the app. Running them together could send a card that review is about to withdraw (the app has no retract)
// or send the same card twice (a duplicate GitHub issue). The lock file holds the owner's pid; a dead owner's lock is stale.
// A reclaimer that crashes between taking its token and removing the stale lock leaves the vault locked (fail closed):
// tick then reports `locked` every hour and the other commands stop with a message naming the lock file.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atticMkdir, atticPath, atticWritePath } from './vault.mjs';

const DIR = 'state';
const REL = `${DIR}/run.lock`;

function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// A lock file is created empty and gets its pid a moment later: an unreadable lock is "being taken", not stale, unless old.
const INIT_GRACE_MS = 60 * 1000;

/** {pid, held, id} for the lock at `file` (id = which file: inode, mtime, content), or null when there is none. */
function inspect(file) {
  let text, st;
  try { st = fs.statSync(file); text = fs.readFileSync(file, 'utf8').trim(); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const pid = /^\d+$/.test(text) ? Number(text) : NaN;
  const id = `${st.ino}:${st.mtimeMs}:${text}`;
  if (Number.isInteger(pid) && pid > 0) return { pid, id, held: pid === process.pid || ownerAlive(pid) };
  return { pid: NaN, id, held: Date.now() - st.mtimeMs < INIT_GRACE_MS };
}

// Reclaim tokens: `run.lock.reclaim-<hash of the stale file's identity>` directories. mkdir is atomic, so exactly one
// contender may reclaim a given stale file; nobody else ever moves it, and a live owner's lock (another identity) is
// never touched by a contender that paused after inspecting an older one. Tokens are kept a day, then swept.
const TOKEN_PREFIX = 'run.lock.reclaim-';
const TOKEN_KEEP_MS = 24 * 60 * 60 * 1000;

function sweepTokens(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.startsWith(TOKEN_PREFIX)); } catch { return; }
  for (const n of names) {
    try { const st = fs.statSync(path.join(dir, n)); if (Date.now() - st.mtimeMs > TOKEN_KEEP_MS) fs.rmdirSync(path.join(dir, n)); } catch { /* gone */ }
  }
}

/** Take the lock now or return null. Returns a release function. */
export function tryRunLock(vault) {
  atticMkdir(vault, DIR);
  const file = atticWritePath(vault, REL);
  const dir = path.dirname(file);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      sweepTokens(dir);
      return () => { try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file); } catch { /* gone */ } };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const seen = inspect(file);
    if (!seen) continue; // released meanwhile
    if (seen.held) return null;
    // Stale (the owner died): claim the right to reclaim this exact file first.
    const token = path.join(dir, TOKEN_PREFIX + createHash('sha256').update(seen.id).digest('hex').slice(0, 32));
    try { fs.mkdirSync(token); } catch (e) { if (e.code === 'EEXIST') return null; throw e; } // someone else reclaims it
    // Only the token holder removes this file, and its dead owner cannot, so the path still holds it. Verify anyway.
    const now = inspect(file);
    if (!now || now.id !== seen.id) return null;
    try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return null;
}

/** Run fn under the lock, waiting up to waitMs for another run to finish; throws when it does not. */
export async function withRunLock(vault, fn, { waitMs = 15 * 60 * 1000, pollMs = 2000, now = () => Date.now() } = {}) {
  const until = now() + waitMs;
  let release = tryRunLock(vault);
  while (!release) {
    if (now() >= until) throw new Error(`다른 brain-attic 실행(review·retro·tick·sync·apply)이 끝나지 않아 기다리다 멈췄습니다. 잠시 뒤 다시 실행하세요 (돌고 있는 brain-attic 이 없는데도 계속이면 ${atticPath(vault, REL)} 를 지우세요)`);
    await new Promise((r) => setTimeout(r, pollMs));
    release = tryRunLock(vault);
  }
  try { return await fn(); } finally { release(); }
}
