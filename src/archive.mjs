// Archive executor (D-003, 2026-11-09): an approved d card (archive_note) moves its vault note to
// 90_Archive/<same relative path>, the vault's archive convention (_system/VAULT_SETUP.md, and the notes archived by
// hand before this existed). This is the ONE place brain-attic writes outside _attic/, and it only ever moves:
//   - link(from, to) then unlink(from): never overwrites a file at the target (link fails if it exists), same inode,
//     so the content cannot change on the way; sha256 is still checked before and after.
//   - each move is recorded in _attic/archive/ledger.json (intent first, then the result) and `attic archive undo`
//     reverses it the same way.
//   - a note that other notes reach by a path ([[folder/note]], [text](path.md)) or whose name is not unique in the
//     vault is not moved: Obsidian finds [[name]] links by file name, so only those survive a move.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireVault } from './config.mjs';
import { atticPath, atticWritePath, ensureSkeleton, writeAtticJson } from './vault.mjs';
import { readJson } from './util.mjs';
import { getProposal, isApplicable, listProposals, saveProposal } from './proposals.mjs';

export const ARCHIVE_ROOT = '90_Archive';
/** Folders challengekim's public digest reads (VAULT_SETUP «collect-digest-material» allowlist): a moved note leaves it. */
export const PUBLIC_ALLOWLIST = ['10_Knowledge/References/', '00_Inbox/Read Later/'];
const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules']);
const ledgerRel = 'archive/ledger.json';

export const archiveTarget = (file) => `${ARCHIVE_ROOT}/${file}`;
const sha = (abs) => crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
const noExt = (rel) => rel.replace(/\.md$/i, '');
const posix = (p) => p.split(path.sep).join('/');

export function readArchiveLedger(vault) { return readJson(atticPath(vault, ledgerRel), []) || []; }
function saveLedger(vault, entries) { writeAtticJson(vault, ledgerRel, entries); }

/**
 * A vault-relative note path we may move: relative, no "..", a .md file, not under _attic/, _system/, 90_Archive/ or a
 * dot folder, and no symlink anywhere on the way (the note itself or a folder above it). Returns an error text or null.
 */
export function badSource(vault, file) {
  if (typeof file !== 'string' || !file || file.includes('\0') || path.isAbsolute(file) || /^[A-Za-z]:/.test(file)) return '볼트 안 상대 경로가 아님';
  const parts = file.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) return '경로에 . 이나 .. 이 있음';
  if (!/\.md$/i.test(file)) return '.md 노트가 아님';
  if (['_attic', '_system', ARCHIVE_ROOT].includes(parts[0]) || parts.some((p) => p.startsWith('.'))) return `${parts[0]} 아래는 옮기지 않음`;
  let cur = vault;
  for (const p of parts) {
    cur = path.join(cur, p);
    let st;
    try { st = fs.lstatSync(cur); } catch { return null; } // missing: the plan reports it as missing/already
    if (st.isSymbolicLink()) return `심볼릭 링크를 거침: ${posix(path.relative(vault, cur))}`;
  }
  return null;
}

function walkMd(vault) {
  const out = [];
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && /\.md$/i.test(e.name)) out.push(posix(path.relative(vault, abs)));
    }
  };
  walk(vault);
  return out;
}

const WIKI = /!?\[\[([^\]\n]+?)\]\]/g;
const REFDEF = /^\s{0,3}\[[^\]\n]+\]:\s*(.*)$/;

/**
 * The text a markdown link could point with on this line: everything after each `](` and a reference definition's
 * target (`[r]: path.md`). Deliberately loose (the rest of the line, parentheses and all): a markdown link we fail to
 * parse must not turn into a false "safe to move".
 */
function mdLinkTails(line) {
  const out = [];
  let i = line.indexOf('](');
  while (i >= 0) { out.push(line.slice(i + 2)); i = line.indexOf('](', i + 2); }
  const ref = REFDEF.exec(line);
  if (ref) out.push(ref[1]);
  return out;
}

/**
 * One pass over every note: which of `files` other notes link to, and how.
 *   name   [[basename]] links (survive a move when the name is unique)
 *   path   [[folder/…/basename]] links (block: a path link may stop resolving)
 *   md     [text](relative/or/root/path.md) links that resolve to the file (block)
 *   attic  links of either kind from _attic/ (brain-attic's own generated sheets: counted, never block)
 *   pathMentions  the file's path written as plain text outside _attic (e.g. the wiki index): becomes stale, reported
 * Also the number of other notes with the same file name (an ambiguous [[name]]).
 */
export function linkIndex(vault, files) {
  const all = walkMd(vault);
  const want = new Map(files.map((f) => [f, { name: 0, path: 0, md: 0, attic: 0, pathMentions: 0, sameName: 0, from: [] }]));
  const byName = new Map();
  for (const f of files) {
    const n = path.posix.basename(noExt(f)).toLowerCase();
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(f);
  }
  for (const rel of all) {
    const n = path.posix.basename(noExt(rel)).toLowerCase();
    for (const f of byName.get(n) || []) if (rel !== f) want.get(f).sameName++;
  }
  const byPath = new Map(files.map((f) => [noExt(f).toLowerCase(), f]));
  // How a markdown link may spell each file's name: as is, or URL-encoded (spaces as %20, or everything encoded).
  const needles = new Map(files.map((f) => {
    const b = path.posix.basename(f);
    return [f, [...new Set([b, encodeURI(b), encodeURIComponent(b), b.replace(/ /g, '%20')].map((x) => x.toLowerCase()))]];
  }));
  // Every note is a link source, the candidates too (one candidate may link another); only a note's links to itself are ignored.
  for (const rel of all) {
    let text;
    try { text = fs.readFileSync(path.join(vault, rel), 'utf8'); } catch { continue; }
    if (!text.includes('[[') && !text.includes('](') && !text.includes(']:') && !files.some((f) => text.includes(f))) continue;
    const inAttic = rel.startsWith('_attic/');
    const hit = (f, kind) => { if (f === rel) return; const w = want.get(f); if (inAttic) w.attic++; else { w[kind]++; if (w.from.length < 5 && !w.from.includes(rel)) w.from.push(rel); } };
    for (const m of text.matchAll(WIKI)) {
      const target = m[1].split('|')[0].split('#')[0].split('^')[0].trim().replace(/\.md$/i, '').replace(/^\/+/, '');
      if (!target) continue;
      if (target.includes('/')) {
        const t = target.toLowerCase();
        for (const [p, f] of byPath) if (p === t || p.endsWith('/' + t)) hit(f, 'path');
      } else for (const f of byName.get(target.toLowerCase()) || []) hit(f, 'name');
    }
    if (text.includes('](') || text.includes(']:')) {
      for (const line of text.split('\n')) {
        for (const tail of mdLinkTails(line)) {
          const t = tail.toLowerCase();
          for (const [f, ns] of needles) if (ns.some((n) => t.includes(n))) hit(f, 'md');
        }
      }
    }
    if (!inAttic) for (const f of files) if (f !== rel && text.includes(f)) want.get(f).pathMentions++;
  }
  return want;
}

/** Why links block a move (null = they survive it). */
function linkBlock(l) {
  if (l.path) return `다른 노트가 경로 링크([[폴더/…]]) ${l.path}개로 가리킴 — 옮기면 깨질 수 있음 (${l.from.join(', ')})`;
  if (l.md) return `다른 노트의 마크다운 링크 ${l.md}개가 이 파일 이름을 가리킴 — 옮기면 깨질 수 있음 (${l.from.join(', ')})`;
  if (l.name && l.sameName) return `같은 이름의 노트가 ${l.sameName}개 더 있어 [[이름]] 링크 ${l.name}개가 다른 노트로 갈 수 있음`;
  return null;
}

/**
 * Plan for approved archive_note proposals (or the given list). Row status:
 *   ready     will be moved            already  the note is already at the target and gone from its place (closed as applied)
 *   missing   neither place has it     conflict a different file sits at the target (never overwritten)
 *   half      a move stopped between link and unlink (same file at both places): finished by removing the old link
 *   blocked   links would break        invalid  the path is not a note we may move
 *   undone    `attic archive undo` put it back: not moved again
 */
export function planArchive(vault, proposals = null, { index = null } = {}) {
  const ps = (proposals || listProposals(vault, { status: 'approved' })).filter((p) => p?.payload?.op === 'archive_note');
  const rows = ps.map((p) => {
    const from = p.payload.file;
    const row = { id: p.id, title: p.payload.title || '', from, to: null, status: 'ready', reason: '' };
    if (p.archiveUndoneAt) return { ...row, status: 'undone', reason: '되돌린 보관 — 다시 옮기지 않음' };
    const bad = badSource(vault, from);
    if (bad) return { ...row, status: 'invalid', reason: bad };
    row.to = archiveTarget(from);
    row.leavesPublic = PUBLIC_ALLOWLIST.some((x) => from.startsWith(x));
    const toBad = symlinkOnTarget(vault, row.to);
    if (toBad) return { ...row, status: 'invalid', reason: toBad };
    const fa = path.join(vault, from), ta = path.join(vault, row.to);
    const fst = statOrNull(fa), tst = statOrNull(ta);
    if (!fst && tst) return { ...row, status: 'already', reason: '이미 보관 폴더에 있음' };
    if (!fst) return { ...row, status: 'missing', reason: '노트가 원 경로에도 보관 폴더에도 없음' };
    if (!fst.isFile()) return { ...row, status: 'invalid', reason: '파일이 아님' };
    if (tst) {
      if (tst.ino === fst.ino && tst.dev === fst.dev) return { ...row, status: 'half', reason: '이동이 중간에 멈춤(같은 파일이 두 곳에 있음) — 원 경로 링크만 지우면 끝남' };
      return { ...row, status: 'conflict', reason: '보관 폴더 같은 자리에 다른 파일이 있음 — 덮어쓰지 않음' };
    }
    return row;
  });
  const ready = rows.filter((r) => ['ready', 'half'].includes(r.status));
  if (ready.length) {
    const idx = index || linkIndex(vault, ready.map((r) => r.from));
    for (const r of ready) {
      const l = idx.get(r.from);
      if (!l) continue;
      r.links = { name: l.name, path: l.path, md: l.md, attic: l.attic, pathMentions: l.pathMentions, sameName: l.sameName };
      const why = linkBlock(l); // a half-finished move too: removing the old entry would break the same links
      if (why) { r.status = 'blocked'; r.reason = why; }
    }
  }
  return rows;
}

function statOrNull(abs) { try { return fs.statSync(abs); } catch { return null; } }
function symlinkOnTarget(vault, rel) {
  let cur = vault;
  for (const p of rel.split('/')) {
    cur = path.join(cur, p);
    let st;
    try { st = fs.lstatSync(cur); } catch { return null; }
    if (st.isSymbolicLink()) return `보관 경로가 심볼릭 링크를 거침: ${posix(path.relative(vault, cur))}`;
  }
  return null;
}

/** Closes the proposal after a move (or a note found already archived) and drops its now pointless instruction file. */
function closeProposal(vault, id, to, now, extra = {}) {
  const p = getProposal(vault, id);
  if (p.promptFile) {
    try { fs.unlinkSync(atticWritePath(vault, p.promptFile)); } catch { /* already gone */ }
  }
  delete p.promptFile;
  Object.assign(p, { status: 'applied', appliedAt: now.toISOString(), archivedTo: to, ...extra });
  saveProposal(vault, p);
}

/**
 * Remove the old directory entry only if it is still the very file now at the archive path. Renaming it aside first is
 * atomic, so an editor that saved a NEW file at the old path in the meantime gets that file back (never deleted).
 */
function removeOldEntry(fa, ta) {
  const aside = path.join(path.dirname(fa), `.attic-archiving-${process.pid}-${crypto.randomBytes(4).toString('hex')}.md`);
  fs.renameSync(fa, aside);
  const a = fs.lstatSync(aside), t = fs.lstatSync(ta);
  if (a.ino === t.ino && a.dev === t.dev) { fs.unlinkSync(aside); return; }
  // Not our file any more (saved anew): put it back where it was. If yet another file appeared there, keep it aside.
  try { fs.linkSync(aside, fa); fs.unlinkSync(aside); }
  catch { throw new Error(`이동 중 원래 자리에 새로 저장된 파일이 있어 ${path.basename(aside)} 로 남겨 둠 — 직접 확인 필요`); }
  throw new Error('이동 중 원래 자리의 노트가 새로 저장됨 — 그 노트는 그대로 두고, 보관 폴더에는 이전 내용이 남음');
}

/** Move one planned row (status ready or half). Returns { ok, error? }. opts.beforeUnlink: test hook. */
export function moveOne(vault, row, now = new Date(), opts = {}) {
  const fa = path.join(vault, row.from), ta = path.join(vault, row.to);
  const ledger = readArchiveLedger(vault);
  const hash = sha(fa);
  const entry = { proposalId: row.id, from: row.from, to: row.to, sha256: hash, bytes: fs.statSync(fa).size, status: 'moving', startedAt: now.toISOString() };
  ledger.push(entry);
  saveLedger(vault, ledger); // intent first: a crash in between leaves a record of where the note went
  try {
    if (row.status !== 'half') {
      fs.mkdirSync(path.dirname(ta), { recursive: true });
      // A hard link: fails with EEXIST instead of overwriting, and the note never exists as a half-written copy. No
      // copy fallback: a vault split across disks is reported, not worked around.
      fs.linkSync(fa, ta);
    }
    if (sha(ta) !== hash) throw new Error('보관본 해시가 원본과 다름 — 원본을 지우지 않음');
    opts.beforeUnlink?.();
    removeOldEntry(fa, ta);
    if (fs.existsSync(fa) || !fs.existsSync(ta) || sha(ta) !== hash) throw new Error('이동 뒤 확인 실패');
  } catch (e) {
    entry.status = 'failed'; entry.error = e.message;
    saveLedger(vault, ledger);
    return { ok: false, error: e.message };
  }
  entry.status = 'moved'; entry.movedAt = now.toISOString();
  saveLedger(vault, ledger);
  // The note has moved and the ledger says so; a failure closing the card is retried by the next run (status already).
  try { closeProposal(vault, row.id, row.to, now); } catch (e) { return { ok: false, error: `옮겼지만 제안을 닫지 못함: ${e.message}` }; }
  return { ok: true };
}

/**
 * A note already at the archive path and gone from its place. When our own move did that but stopped before the ledger
 * said 'moved' (crash, or closing the card failed), the ledger entry is recovered (same hash) so undo still works.
 */
export function closeAlready(vault, row, now = new Date()) {
  const ledger = readArchiveLedger(vault);
  const mine = ledger.filter((e) => e.proposalId === row.id && e.from === row.from && e.to === row.to);
  const ours = !mine.some((e) => e.status === 'moved') && [...mine].reverse().find((e) => ['moving', 'failed'].includes(e.status) && e.sha256 === sha(path.join(vault, row.to)));
  if (ours) { ours.status = 'moved'; ours.movedAt = now.toISOString(); ours.recovered = true; delete ours.error; saveLedger(vault, ledger); }
  closeProposal(vault, row.id, row.to, now, ours || mine.some((e) => e.status === 'moved') ? {} : { archivedBefore: true });
}

/**
 * Plan, and unless dryRun move up to `limit` ready notes. Proposals must be approved and applicable (TTL rule).
 * Returns { plan, moved, already, skipped, errors }.
 */
export async function runArchive(ctx, { dryRun = false, limit = Infinity, now = new Date(), proposals = null } = {}) {
  const vault = requireVault(ctx);
  ensureSkeleton(vault);
  const ps = (proposals || listProposals(vault, { status: 'approved' })).filter((p) => p.payload?.op === 'archive_note' && isApplicable(p))
    .sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)) || String(x.payload.file).localeCompare(String(y.payload.file)));
  const plan = planArchive(vault, ps);
  const out = { plan, moved: [], already: [], skipped: [], errors: [] };
  if (dryRun) return out;
  for (const r of plan) {
    if (r.status === 'already') { closeAlready(vault, r, now); out.already.push(r); continue; }
    if (!['ready', 'half'].includes(r.status)) { out.skipped.push(r); continue; }
    if (out.moved.length >= limit) { out.skipped.push({ ...r, reason: '이번 실행 상한(--limit) 밖' }); continue; }
    const m = moveOne(vault, r, now);
    if (m.ok) out.moved.push(r); else out.errors.push({ ...r, error: m.error });
  }
  return out;
}

/** Put archived notes back (ids = proposal ids, or 'all'). Refuses when the archived copy changed or the old place is taken. */
export function undoArchive(vault, ids, { now = new Date() } = {}) {
  const ledger = readArchiveLedger(vault);
  const out = { restored: [], refused: [] };
  const targets = ledger.filter((e) => e.status === 'moved' && (ids === 'all' || ids.includes(e.proposalId)));
  if (ids !== 'all') for (const id of ids) if (!targets.some((e) => e.proposalId === id)) out.refused.push({ proposalId: id, reason: '옮긴 기록이 없음' });
  for (const e of targets) {
    const fa = path.join(vault, e.from), ta = path.join(vault, e.to);
    const why = badSource(vault, e.from) || (e.to !== archiveTarget(e.from) ? '원장의 보관 경로가 규칙과 다름' : null) || symlinkOnTarget(vault, e.to)
      || (!fs.existsSync(ta) ? '보관본이 없음'
      : fs.existsSync(fa) ? '원 경로에 이미 다른 파일이 있음' : sha(ta) !== e.sha256 ? '보관본이 옮긴 뒤 바뀜' : null);
    if (why) { out.refused.push({ proposalId: e.proposalId, from: e.from, reason: why }); continue; }
    fs.mkdirSync(path.dirname(fa), { recursive: true });
    fs.linkSync(ta, fa);
    if (sha(fa) !== e.sha256) { fs.unlinkSync(fa); out.refused.push({ proposalId: e.proposalId, from: e.from, reason: '되돌린 파일 해시가 다름' }); continue; }
    fs.unlinkSync(ta);
    e.status = 'undone'; e.undoneAt = now.toISOString();
    const p = getProposal(vault, e.proposalId);
    if (p) { p.archiveUndoneAt = now.toISOString(); saveProposal(vault, p); }
    out.restored.push(e);
  }
  saveLedger(vault, ledger);
  return out;
}

const STATUS_KO = { ready: '옮길 것', already: '이미 보관됨', missing: '없음', conflict: '충돌', half: '중간에 멈춤', blocked: '링크 때문에 보류', invalid: '옮길 수 없는 경로', undone: '되돌림' };
export function renderPlan(plan) {
  const L = [];
  const count = (s) => plan.filter((r) => r.status === s).length;
  L.push(`보관 계획 ${plan.length}건: ${Object.keys(STATUS_KO).filter(count).map((s) => `${STATUS_KO[s]} ${count(s)}`).join(' · ')}`);
  for (const r of plan) {
    L.push(`- [${STATUS_KO[r.status]}] ${r.id}  ${r.from}`);
    if (r.to && ['ready', 'half', 'already', 'conflict', 'blocked'].includes(r.status)) L.push(`    -> ${r.to}`);
    if (r.reason) L.push(`    ${r.reason}`);
    if (r.links) L.push(`    링크: 이름 [[ ]] ${r.links.name} · 경로 ${r.links.path + r.links.md} · attic 기록 ${r.links.attic} · 경로 언급(색인 등) ${r.links.pathMentions}${r.leavesPublic ? ' · 공개 재료 허용 목록에서 빠짐' : ''}`);
  }
  return L.join('\n');
}
