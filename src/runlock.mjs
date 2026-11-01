// One proposal-changing run at a time per vault: review, retro, tick, sync, apply.
// review classifies, deduplicates and withdraws cards before it announces them; tick re-sends announced cards that did
// not reach the app. Running them together could send a card that review is about to withdraw (the app has no retract)
// or send the same card twice (a duplicate GitHub issue). The lock file holds the owner's pid; a dead owner's lock is stale.
import fs from 'node:fs';
import { atticMkdir, atticPath, atticWritePath } from './vault.mjs';

const DIR = 'state';
const REL = `${DIR}/run.lock`;

function ownerAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Take the lock now or return null. Returns a release function. */
export function tryRunLock(vault) {
  atticMkdir(vault, DIR);
  const file = atticWritePath(vault, REL);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      try { fs.writeSync(fd, String(process.pid)); } finally { fs.closeSync(fd); }
      return () => { try { if (fs.readFileSync(file, 'utf8').trim() === String(process.pid)) fs.unlinkSync(file); } catch { /* gone */ } };
    } catch (e) { if (e.code !== 'EEXIST') throw e; }
    let pid = NaN;
    try { pid = Number(fs.readFileSync(atticPath(vault, REL), 'utf8').trim()); } catch { continue; } // released meanwhile
    if (ownerAlive(pid) || pid === process.pid) return null;
    try { fs.unlinkSync(file); } catch { /* someone else cleared it */ } // stale: the owner died
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
