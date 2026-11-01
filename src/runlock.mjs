// One proposal-changing run at a time per vault: review, retro, tick, sync, apply.
// review classifies, deduplicates and withdraws cards before it announces them; tick re-sends announced cards that did
// not reach the app. Running them together could send a card that review is about to withdraw (the app has no retract)
// or send the same card twice (a duplicate GitHub issue). The lock file holds the owner's pid; a dead owner's lock is stale.
// Residual: a stale lock reclaimed by three contenders at the same instant can still let two through (needs a crash first).
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
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

/** Take the lock now or return null. Returns a release function. */
export function tryRunLock(vault) {
  atticMkdir(vault, DIR);
  const file = atticWritePath(vault, REL);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return () => { try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file); } catch { /* gone */ } };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    const seen = inspect(file);
    if (!seen) continue; // released meanwhile
    if (seen.held) return null;
    // Stale (the owner died). Move it aside atomically: only one contender can move a given file. If what we moved is not
    // the dead lock we inspected (someone reclaimed it and took a fresh one in between), put it back and back off.
    const aside = `${file}.stale-${process.pid}-${randomUUID()}`;
    try { fs.renameSync(file, aside); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    let moved = null;
    try { const st = fs.statSync(aside); moved = `${st.ino}:${st.mtimeMs}:${fs.readFileSync(aside, 'utf8').trim()}`; } catch { /* vanished */ }
    if (moved !== seen.id) {
      try { fs.linkSync(aside, file); } catch { /* a new holder exists already */ }
      try { fs.unlinkSync(aside); } catch { /* gone */ }
      return null;
    }
    try { fs.unlinkSync(aside); } catch { /* gone */ }
  }
  return null;
}

/** Run fn under the lock, waiting up to waitMs for another run to finish; throws when it does not. */
export async function withRunLock(vault, fn, { waitMs = 15 * 60 * 1000, pollMs = 2000, now = () => Date.now() } = {}) {
  const until = now() + waitMs;
  let release = tryRunLock(vault);
  while (!release) {
    if (now() >= until) throw new Error('다른 brain-attic 실행(review·retro·tick·sync·apply)이 끝나지 않아 기다리다 멈췄습니다. 잠시 뒤 다시 실행하세요');
    await new Promise((r) => setTimeout(r, pollMs));
    release = tryRunLock(vault);
  }
  try { return await fn(); } finally { release(); }
}
