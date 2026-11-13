// Vault helpers. brain-attic only WRITES under <vault>/_attic/. User notes are read-only -- the one exception is
// src/archive.mjs, which MOVES an approved d note to 90_Archive/ and rewrites the references to that note's full path
// in other notes (replaceNoteIfUnchanged below). It never deletes a note.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeFileAtomic } from './util.mjs';

export const ATTIC_DIRS = ['inbox', 'saved', 'state', 'radar', 'triage', 'reviews', 'proposals', 'approved', 'retro', 'teach', 'feedback', 'rules', 'archive'];

export function atticRoot(vault) { return path.join(vault, '_attic'); }
export function atticPath(vault, ...p) { return path.join(vault, '_attic', ...p); }

/**
 * The ONE gate for writing under <vault>/_attic. Returns the absolute target path or throws.
 * Rejects: absolute paths, "..", NUL, any symlink on vault/_attic or on any existing step below it
 * (including the final file), and anything whose realpath lands outside realpath(vault)/_attic.
 * (A race between this check and the write is not closed -- the vault is the user's own directory.)
 */
export function atticWritePath(vault, rel) {
  if (typeof rel !== 'string' || rel.includes('\0') || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) throw new Error(`_attic 밖에는 쓰지 않습니다: ${rel}`);
  const parts = rel.split(/[\\/]+/).filter((p) => p && p !== '.');
  if (parts.includes('..')) throw new Error(`_attic 밖에는 쓰지 않습니다: ${rel}`);
  const root = atticRoot(vault);
  const chain = [root];
  for (const p of parts) chain.push(path.join(chain[chain.length - 1], p));
  let deepest = null;
  for (const c of chain) {
    let st;
    try { st = fs.lstatSync(c); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') break; throw e; }
    if (st.isSymbolicLink()) throw new Error(`심볼릭 링크를 거치는 _attic 쓰기는 거부합니다: ${path.relative(vault, c)}`);
    deepest = c;
  }
  let vaultReal;
  try { vaultReal = fs.realpathSync(vault); } catch { vaultReal = path.resolve(vault); }
  const rootReal = path.join(vaultReal, '_attic');
  if (deepest) {
    const real = fs.realpathSync(deepest);
    if (real !== rootReal && !real.startsWith(rootReal + path.sep)) throw new Error(`_attic 밖으로 이어지는 경로입니다: ${rel}`);
  }
  return chain[chain.length - 1];
}

/** mkdir -p under _attic through the same gate. */
export function atticMkdir(vault, rel) {
  const target = atticWritePath(vault, rel);
  fs.mkdirSync(target, { recursive: true });
  return target;
}

export function ensureSkeleton(vault) {
  atticMkdir(vault, '');
  for (const d of ATTIC_DIRS) atticMkdir(vault, d);
}

export function writeAttic(vault, rel, data) {
  const target = atticWritePath(vault, rel);
  writeFileAtomic(target, data);
  return target;
}
export function writeAtticJson(vault, rel, obj) { return writeAttic(vault, rel, JSON.stringify(obj, null, 2) + '\n'); }

/** Copy a file into _attic through the gate; never overwrites. Returns false when it already exists. */
export function copyIntoAttic(vault, rel, srcFile) {
  const target = atticWritePath(vault, rel);
  if (fs.existsSync(target)) return false;
  writeFileAtomic(target, fs.readFileSync(srcFile));
  return true;
}

const sameBytes = (p, buf) => { try { return fs.readFileSync(p).equals(buf); } catch { return false; } };
const dropName = (p) => { try { fs.unlinkSync(p); } catch { /* gone */ } };
const relinkTag = () => crypto.randomBytes(6).toString('hex');

/** Put the file named `src` at `abs` without overwriting anything there (hard link, then drop the src name). false = taken. */
export function placeNoClobber(src, abs) {
  try { fs.linkSync(src, abs); } catch (e) { if (e.code === 'EEXIST') return false; throw e; }
  fs.unlinkSync(src);
  return true;
}

/**
 * Free `abs` only if it still holds exactly `isOurs(bytes)`: renamed away first (atomic), checked by CONTENT, and put
 * back without overwriting if it is not ours. true = the path is free now; false = someone else's file is there.
 */
export function takeBackIfOurs(abs, isOurs) {
  const q = path.join(path.dirname(abs), `.attic-relink-${relinkTag()}.take`);
  try { fs.renameSync(abs, q); } catch (e) { if (e.code === 'ENOENT') return true; throw e; }
  if (isOurs(fs.readFileSync(q))) { fs.unlinkSync(q); return true; }
  if (placeNoClobber(q, abs)) return false;
  throw new Error(`노트를 제자리에 돌려놓지 못함 — ${path.basename(q)} 에 남아 있음, 직접 확인 필요`);
}

/** Keep a file as a visible note next to `abs` («<이름> (보관 링크 충돌 <tag>).md»), never overwriting. Returns its name. */
export function keepAsConflict(src, abs) {
  const base = path.basename(abs).replace(/\.md$/i, '');
  for (;;) {
    const c = path.join(path.dirname(abs), `${base} (보관 링크 충돌 ${relinkTag()}).md`);
    if (placeNoClobber(src, c)) return path.basename(c);
  }
}

/**
 * The one write brain-attic makes to a note outside _attic/ (archive relink, src/archive.mjs, which checks the path):
 * put `text` at `abs` if it still holds exactly `raw`. Nothing is ever renamed onto an existing file and no bytes we
 * cannot prove are ours are dropped, so an editor's save made meanwhile is never lost:
 *   1. write a fresh temp file (wx);  2. journal, then rename the original aside (atomic);
 *   3. link ours to the path without overwriting — an editor's new file there wins;
 *   4. the original set aside was edited in place meanwhile -> take ours back only if its content is still ours and
 *      put the edited original at the path (no overwrite); if both sides changed, the edited original is kept as a
 *      visible conflict note next to it.
 * Throws whenever ours did not end up at the path (the caller retries later). `journal({ tmp, aside })` before step 2,
 * `journal(null)` only once the files are consistent again; a crash in between is settled by settleRelinkAside
 * (archive.mjs). hooks: tests only.
 */
export function replaceNoteIfUnchanged(abs, raw, text, mode = 0o644, journal = null, hooks = {}) {
  const tag = relinkTag();
  const tmp = path.join(path.dirname(abs), `.attic-relink-${tag}.tmp`);
  const aside = path.join(path.dirname(abs), `.attic-relink-${tag}.orig`);
  const ours = Buffer.from(text, 'utf8');
  fs.writeFileSync(tmp, ours, { flag: 'wx', mode });
  journal?.({ tmp, aside });
  try { fs.renameSync(abs, aside); } catch (e) { dropName(tmp); journal?.(null); throw e; }
  hooks.afterAside?.(aside);
  // The path holds someone's newer file: the original aside goes away if unchanged, else it stays as a conflict note.
  const yieldTo = (why) => {
    dropName(tmp);
    if (sameBytes(aside, raw)) { dropName(aside); journal?.(null); throw new Error(`${why} — 새 노트는 그대로 두고 다음 실행 때 다시 고침`); }
    const c = keepAsConflict(aside, abs);
    journal?.(null);
    throw new Error(`${why} — 새 노트는 그대로 두고, 그 전에 바뀐 내용은 «${c}» 로 남김`);
  };
  let placed;
  try { placed = placeNoClobber(tmp, abs); } catch (e) {
    // Ours could not be linked: put the original back (no overwrite). If that fails too the journal stays.
    if (placeNoClobber(aside, abs)) { dropName(tmp); journal?.(null); }
    throw e;
  }
  if (!placed) yieldTo('고치는 사이에 노트가 새로 저장됨');
  hooks.afterLink?.(aside);
  if (sameBytes(aside, raw)) { dropName(aside); journal?.(null); return; }
  // The original was edited in place before we set it aside: that edit wins over our rewrite.
  if (!takeBackIfOurs(abs, (b) => b.equals(ours))) yieldTo('고치는 사이에 노트가 바뀌고 새로 저장됨');
  if (!placeNoClobber(aside, abs)) yieldTo('고치는 사이에 노트가 바뀌고 새로 저장됨');
  journal?.(null);
  throw new Error('고치는 사이에 노트가 바뀜 — 바뀐 내용을 그대로 두고 다음 실행 때 다시 고침');
}

/** Per-vault random id (created once). Proposal ids derive from it so they cannot collide with another vault's. */
export function getInstanceId(vault) {
  const rel = 'state/instance.json';
  const cur = readJson(atticPath(vault, rel), null);
  if (cur && typeof cur.instanceId === 'string' && cur.instanceId.length >= 16) return cur.instanceId;
  const instanceId = crypto.randomUUID();
  writeAtticJson(vault, rel, { instanceId, createdAt: new Date().toISOString() });
  return instanceId;
}

// ---- frontmatter (YAML subset: scalars, inline [a, b] lists, "- item" lists) ----
function scalar(v) {
  v = v.trim();
  if (v === '') return '';
  if ((v.startsWith('"') && v.endsWith('"') && v.length > 1)) { try { return JSON.parse(v); } catch { return v.slice(1, -1); } }
  if (v.startsWith("'") && v.endsWith("'") && v.length > 1) return v.slice(1, -1).replace(/''/g, "'");
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}
function splitInline(s) {
  const out = []; let cur = '', q = null;
  for (const ch of s) {
    if (q) { cur += ch; if (ch === q) q = null; }
    else if (ch === '"' || ch === "'") { q = ch; cur += ch; }
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.trim() !== '') out.push(cur);
  return out;
}

export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { data: {}, body: text };
  const data = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    if (/^\s*#/.test(line) || line.trim() === '') continue;
    const li = /^\s+-\s+(.*)$/.exec(line) || (key && Array.isArray(data[key]) ? /^-\s+(.*)$/.exec(line) : null);
    if (li && key) { if (!Array.isArray(data[key])) data[key] = []; data[key].push(scalar(li[1])); continue; }
    const kv = /^([A-Za-z0-9_\-가-힣]+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1];
    const val = kv[2].trim();
    if (val === '') data[key] = [];
    else if (val.startsWith('[') && val.endsWith(']')) data[key] = splitInline(val.slice(1, -1)).map(scalar);
    else data[key] = scalar(val);
  }
  for (const k of Object.keys(data)) if (Array.isArray(data[k]) && data[k].length === 0) data[k] = '';
  return { data, body: m[2] };
}

export function stringifyFrontmatter(data, body = '') {
  const lines = Object.entries(data).map(([k, v]) => {
    if (Array.isArray(v)) return `${k}: [${v.map((x) => JSON.stringify(x)).join(', ')}]`;
    if (typeof v === 'string') return `${k}: ${JSON.stringify(v)}`;
    return `${k}: ${v}`;
  });
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

/** Recursively list .md files under dir modified at/after sinceMs. Skips _attic, dot-dirs, node_modules. */
export function listRecentMd(dir, { sinceMs = 0, untilMs = Infinity, maxFiles = 2000 } = {}) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > 8 || out.length >= maxFiles) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '_attic') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.md')) {
        try { const st = fs.statSync(p); if (st.mtimeMs >= sinceMs && st.mtimeMs < untilMs) out.push({ file: p, mtimeMs: st.mtimeMs }); } catch { /* skip */ }
      }
    }
  };
  walk(dir, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function readProjects(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .map((l) => l.replace(/^\s*[-*]\s+/, '').trim())
      .filter((l) => l && !l.startsWith('#') && !l.startsWith('<!--') && !l.startsWith('---'));
  } catch { return []; }
}

export function projectsFileOf(ctx) {
  const c = ctx.config.projectsFile;
  if (c) return path.resolve(c.startsWith('~') ? path.join(ctx.home, c.slice(1)) : c);
  return ctx.vault ? atticPath(ctx.vault, 'projects.md') : null;
}
