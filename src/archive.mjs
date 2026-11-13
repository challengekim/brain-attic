// Archive executor (D-003, 2026-11-09): an approved d card (archive_note) moves its vault note to
// 90_Archive/<same relative path>, the vault's archive convention (_system/VAULT_SETUP.md, and the notes archived by
// hand before this existed). This is the ONE place brain-attic writes outside _attic/: it moves the note, and rewrites
// the references to its full path in other notes (2026-11-13 owner brief) — nothing else:
//   - link(from, to) then unlink(from): never overwrites a file at the target (link fails if it exists), same inode,
//     so the content cannot change on the way; sha256 is still checked before and after.
//   - each move is recorded in _attic/archive/ledger.json (intent first, then the result) and `attic archive undo`
//     reverses it the same way.
//   - a note other notes reach by its FULL vault path ([[10_Knowledge/…/note|t]], or the path written out as text such
//     as the wiki index's `10_Knowledge/…/note.md`) is moved and those references are rewritten to 90_Archive/… (an
//     atomic rename per note, only if it did not change meanwhile; recorded in the ledger, reversed by undo). Notes
//     under _attic/ or 90_Archive/ and notes that move themselves are never edited: their path links still block.
//   - any other path reference (partial or case-differing [[folder/note]], [text](path.md)) or a name that is not
//     unique in the vault still blocks the move: Obsidian finds [[name]] links by file name, so those survive a move.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { requireVault } from './config.mjs';
import { atticPath, atticWritePath, ensureSkeleton, replaceNoteIfUnchanged, writeAtticJson } from './vault.mjs';
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
/** The note a [[wikilink]] names: before | # ^ (a table's escaped \| too), no .md, no leading /. Case kept. */
function wikiTarget(inner) {
  return inner.split(/[|#^]/)[0].replace(/\\$/, '').trim().replace(/\.md$/i, '').replace(/^\/+/, '');
}
const FENCE = /^\s{0,3}(```|~~~)/;

/**
 * Rewrite the references to one note's full vault path from `fromRel` to `toRel` (both .md paths), and nothing else:
 *   - [[wikilinks]] whose target is exactly that path (with or without .md or a leading /): only the target changes,
 *     the alias, heading, block, embed ! and a table's \| stay;
 *   - the .md path written as an inline code span exactly (`` `10_Knowledge/…/x.md` ``, the wiki index's form),
 *     outside any [[wikilink]] — so `90_Archive/<path>`, `<path> 2.md` or `x/<path>` are never touched.
 * Fenced code blocks, bare text, URLs, other notes' links and aliases, partial or case-differing paths and markdown
 * links are not touched (the last three block the move instead). Reversible: rewriteRefs(rewriteRefs(t, a, b).text,
 * b, a) gives t back unless t already spelled b. Returns { text, count }.
 */
export function rewriteRefs(text, fromRel, toRel) {
  const a = noExt(fromRel), b = noExt(toRel);
  const spanFrom = '`' + fromRel + '`', spanTo = '`' + toRel + '`';
  let count = 0;
  let fence = null; // the open fence's marker
  const plain = (seg) => {
    const parts = seg.split(spanFrom);
    count += parts.length - 1;
    return parts.join(spanTo);
  };
  const lines = text.split('\n').map((line) => {
    const f = FENCE.exec(line);
    if (f) { if (!fence) fence = f[1]; else if (f[1] === fence) fence = null; return line; }
    if (fence || (!line.includes(a))) return line;
    let out = '', last = 0;
    for (const m of line.matchAll(WIKI)) {
      out += plain(line.slice(last, m.index));
      const inner = m[1];
      if (wikiTarget(inner) === a) {
        const i = inner.indexOf(a); // only blanks and slashes can come before it
        count++;
        out += m[0].slice(0, m[0].indexOf('[[') + 2) + inner.slice(0, i) + b + inner.slice(i + a.length) + ']]';
      } else out += m[0];
      last = m.index + m[0].length;
    }
    return out + plain(line.slice(last));
  });
  return { text: lines.join('\n'), count };
}
const REFDEF = /^\s{0,3}\[[^\]\n]+\]:\s*(.*)$/;

/**
 * The text a markdown link could point with on this line: everything after each `](` and a reference definition's
 * target (`[r]: path.md`). Deliberately loose (the rest of the line, parentheses and all): a markdown link we fail to
 * parse must not turn into a false "safe to move".
 */
function mdLinkTails(lines, k) {
  const line = lines[k];
  const out = [];
  let i = line.indexOf('](');
  while (i >= 0) { out.push(line.slice(i + 2)); i = line.indexOf('](', i + 2); }
  const ref = REFDEF.exec(line);
  // A reference definition may put its target on the next line.
  if (ref) out.push(ref[1].trim() ? ref[1] : (lines[k + 1] || ''));
  return out;
}

/**
 * Lower-case and %-decode every run of escapes on its own, so a stray % elsewhere on the line cannot hide a valid
 * (multi-byte, e.g. Korean) name. A run that is not valid UTF-8 is decoded escape by escape, else left as is.
 */
function decodeLoose(s) {
  const one = (m) => { try { return decodeURIComponent(m); } catch { return m; } };
  return s.replace(/(?:%[0-9a-f]{2})+/gi, (run) => { try { return decodeURIComponent(run); } catch { return run.replace(/%[0-9a-f]{2}/gi, one); } }).toLowerCase();
}

/** Whether rewriteNote would accept this note (same checks, without writing). */
function rewritable(vault, rel, raw, text) {
  try {
    const st = fs.lstatSync(path.join(vault, rel));
    return st.isFile() && st.nlink === 1 && !symlinkOnTarget(vault, rel) && Buffer.from(text, 'utf8').equals(raw);
  } catch { return false; }
}

/**
 * One pass over every note: which of `files` other notes link to, and how.
 *   name   [[basename]] links (survive a move when the name is unique)
 *   exact  [[full/vault/path]] links from a note we may edit: rewritten on the move (`relink`: those notes, plus the
 *          ones that write the full path as text), so they do not block
 *   path   other [[folder/…/basename]] links (block: a path link may stop resolving)
 *   md     [text](relative/or/root/path.md) links that resolve to the file (block)
 *   attic  links of either kind from _attic/ (brain-attic's own generated sheets: counted, never block)
 *   pathMentions  the file's path written as plain text outside _attic (e.g. the wiki index): becomes stale, reported
 * Also the number of other notes with the same file name (an ambiguous [[name]]).
 */
export function linkIndex(vault, files) {
  const all = walkMd(vault);
  const want = new Map(files.map((f) => [f, { name: 0, exact: 0, path: 0, md: 0, attic: 0, pathMentions: 0, sameName: 0, from: [], relink: new Set() }]));
  const moving = new Set(files);
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
    return [f, [b.toLowerCase()]]; // matched against the %-decoded link text
  }));
  // Every note is a link source, the candidates too (one candidate may link another); only a note's links to itself are ignored.
  for (const rel of all) {
    let raw, text;
    try { raw = fs.readFileSync(path.join(vault, rel)); text = raw.toString('utf8'); } catch { continue; }
    if (!text.includes('[[') && !text.includes('](') && !text.includes(']:') && !files.some((f) => text.includes(f))) continue;
    const inAttic = rel.startsWith('_attic/');
    // A note we may rewrite: not brain-attic's own records, not an archived note (its hash is in the ledger), not a note
    // that moves itself (its hash is checked on the way).
    // It must also pass rewriteNote's own checks (one hard link, valid UTF-8), or its links would break unfixed.
    const editable = !inAttic && !rel.startsWith(`${ARCHIVE_ROOT}/`) && !moving.has(rel) && rewritable(vault, rel, raw, text);
    const hit = (f, kind) => { if (f === rel) return; const w = want.get(f); if (inAttic) w.attic++; else { w[kind]++; if (w.from.length < 5 && !w.from.includes(rel)) w.from.push(rel); } };
    for (const m of text.matchAll(WIKI)) {
      const target = wikiTarget(m[1]);
      if (!target) continue;
      if (target.includes('/')) {
        const t = target.toLowerCase();
        for (const [p, f] of byPath) if (p === t || p.endsWith('/' + t)) hit(f, editable && target === noExt(f) ? 'exact' : 'path');
      } else for (const f of byName.get(target.toLowerCase()) || []) hit(f, 'name');
    }
    if (text.includes('](') || text.includes(']:')) {
      const lines = text.split('\n');
      for (let k = 0; k < lines.length; k++) {
        for (const tail of mdLinkTails(lines, k)) {
          const t = decodeLoose(tail);
          for (const [f, ns] of needles) if (ns.some((n) => t.includes(n))) hit(f, 'md');
        }
      }
    }
    if (!inAttic) for (const f of files) if (f !== rel && text.includes(f)) want.get(f).pathMentions++;
    if (editable) for (const f of files) if (text.includes(noExt(f)) && rewriteRefs(text, f, archiveTarget(f)).count) want.get(f).relink.add(rel);
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
  const stuck = new Map(readArchiveLedger(vault).filter((e) => e.aside).map((e) => [e.proposalId, e]));
  const rows = ps.map((p) => {
    const from = p.payload.file;
    const row = { id: p.id, title: p.payload.title || '', from, to: null, status: 'ready', reason: '' };
    if (p.archiveUndoneAt) return { ...row, status: 'undone', reason: '되돌린 보관 — 다시 옮기지 않음' };
    // A move stopped with the old file set aside and not yet settled: nothing is closed or moved until it is.
    if (stuck.has(p.id)) return { ...row, to: archiveTarget(from), status: 'blocked', reason: `이동 중 따로 둔 파일이 아직 정리되지 않음 — ${stuck.get(p.id).aside}${stuck.get(p.id).error ? ` (${stuck.get(p.id).error})` : ''}` };
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
      r.links = { name: l.name, exact: l.exact, path: l.path, md: l.md, attic: l.attic, pathMentions: l.pathMentions, sameName: l.sameName };
      const why = linkBlock(l); // a half-finished move too: removing the old entry would break the same links
      if (why) { r.status = 'blocked'; r.reason = why; } else if (l.relink.size) r.relink = [...l.relink].sort();
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
function removeOldEntry(vault, entry, ledger, fa, ta) {
  // An exclusive fresh folder (mkdtemp) next to the note: the rename below can never land on an existing file.
  const dir = fs.mkdtempSync(path.join(path.dirname(fa), '.attic-archiving-'));
  const aside = path.join(dir, 'note.md');
  entry.aside = posix(path.relative(vault, aside));
  saveLedger(vault, ledger); // recorded BEFORE the rename: a crash after it is repaired by recoverAside()
  fs.renameSync(fa, aside);
  settleAside(vault, entry, fa, ta);
  saveLedger(vault, ledger);
  if (entry.restored) throw new Error('이동 중 원래 자리의 노트가 새로 저장됨 — 그 노트는 제자리에 그대로 두고, 보관 폴더에는 이전 내용이 남음');
}

/**
 * The file set aside during a move: our archived inode -> drop the extra name (the move is complete); anything else
 * (saved anew by an editor) -> put it back at the old path. Never deletes a file that is not the archived inode.
 */
function settleAside(vault, entry, fa, ta) {
  const aside = path.join(vault, entry.aside);
  const a = statL(aside);
  if (a) {
    const t = statL(ta);
    if (t && a.ino === t.ino && a.dev === t.dev) fs.unlinkSync(aside);
    else {
      try { fs.linkSync(aside, fa); } catch (e) { throw new Error(`따로 둔 노트를 제자리에 돌려놓지 못함(${e.code}) — ${entry.aside} 에 남아 있음, 직접 확인 필요`); }
      fs.unlinkSync(aside);
      entry.restored = true;
    }
  }
  try { fs.rmdirSync(path.dirname(aside)); } catch { /* not empty or gone */ }
  delete entry.aside;
}
const statL = (abs) => { try { return fs.lstatSync(abs); } catch { return null; } };

/** Before any plan acts: repair moves that stopped while the old file was set aside (see removeOldEntry). */
export function recoverAside(vault, now = new Date()) {
  const ledger = readArchiveLedger(vault);
  const out = [];
  for (const e of ledger) {
    if (!e.aside || !['moving', 'failed'].includes(e.status)) continue;
    try {
      settleAside(vault, e, path.join(vault, e.from), path.join(vault, e.to));
      if (e.restored) { e.status = 'failed'; e.error = '이동 중 원래 자리의 노트가 새로 저장돼 제자리에 돌려놓음'; }
      e.recoveredAt = now.toISOString();
      out.push(e);
    } catch (err) { e.status = 'failed'; e.error = err.message; out.push(e); }
  }
  if (out.length) saveLedger(vault, ledger);
  return out;
}

/**
 * Rewrite one note's references from `fromRel` to `toRel` in place: a regular UTF-8 file with no symlink on the way and
 * no second hard link; written to a fresh temp file next to it and renamed over it, only if the note still reads the
 * same as when we read it. Returns the number of references changed (0 = nothing to do, nothing written).
 */
function rewriteNote(vault, rel, fromRel, toRel, entry = null, ledger = null) {
  const parts = String(rel).split('/');
  if (!rel || path.isAbsolute(rel) || parts.some((p) => !p || p === '.' || p === '..') || !/\.md$/i.test(rel)) throw new Error('볼트 안 노트 경로가 아님');
  if (['_attic', ARCHIVE_ROOT].includes(parts[0])) throw new Error(`${parts[0]} 아래 노트는 고치지 않음`);
  const sym = symlinkOnTarget(vault, rel);
  if (sym) throw new Error(sym);
  const abs = path.join(vault, rel);
  const st = fs.lstatSync(abs);
  if (!st.isFile()) throw new Error('파일이 아님');
  if (st.nlink > 1) throw new Error('하드 링크가 더 있는 파일 — 고치지 않음');
  const raw = fs.readFileSync(abs);
  const text = raw.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(raw)) throw new Error('UTF-8 이 아닌 노트 — 고치지 않음');
  const r = rewriteRefs(text, fromRel, toRel);
  if (!r.count) return 0;
  const hash = crypto.createHash('sha256').update(raw).digest('hex');
  const journal = entry && ((j) => {
    if (j) entry.relinkAside = { file: rel, tmp: posix(path.relative(vault, j.tmp)), aside: posix(path.relative(vault, j.aside)), sha256: hash };
    else delete entry.relinkAside;
    saveLedger(vault, ledger);
  });
  replaceNoteIfUnchanged(abs, raw, r.text, st.mode & 0o777, journal);
  return r.count;
}

/**
 * A link rewrite that stopped mid-swap (see vault.mjs replaceNoteIfUnchanged): the original set aside goes back when
 * the note is missing or the note is still our temp file and the original was edited; an unchanged original next to
 * a note is dropped. Anything else (an editor's new note AND an edited original) is left for a person.
 */
function settleRelinkAside(vault, entry) {
  const j = entry.relinkAside;
  const inVault = (rel) => (typeof rel === 'string' && !badRel(vault, rel) ? path.join(vault, rel) : null);
  const abs = inVault(j.file), aside = inVault(j.aside), tmp = inVault(j.tmp);
  if (!abs || !aside || !tmp || path.dirname(aside) !== path.dirname(abs) || path.dirname(tmp) !== path.dirname(abs)
    || !/^\.attic-relink-[0-9a-f]+\.orig$/.test(path.basename(aside)) || !/^\.attic-relink-[0-9a-f]+\.tmp$/.test(path.basename(tmp))) {
    throw new Error('원장의 링크 고침 기록이 올바르지 않음 — 직접 확인 필요');
  }
  const a = statL(aside);
  if (a) {
    const n = statL(abs), t = statL(tmp);
    const ours = n && t && n.ino === t.ino && n.dev === t.dev;
    const unchanged = sha(aside) === j.sha256;
    if (!n || (ours && !unchanged)) fs.renameSync(aside, abs);
    else if (unchanged) fs.unlinkSync(aside);
    else throw new Error(`링크를 고치다 멈춘 노트의 바뀐 원본이 ${j.aside} 에 남아 있음 — 직접 확인 필요`);
  }
  try { fs.unlinkSync(tmp); } catch { /* gone */ }
  delete entry.relinkAside;
}
function badRel(vault, rel) {
  const parts = rel.split('/');
  return !rel || path.isAbsolute(rel) || parts.some((p) => !p || p === '.' || p === '..') || ['_attic', ARCHIVE_ROOT].includes(parts[0]) || !!symlinkOnTarget(vault, rel);
}

/** Rewrite the references for one moved entry (old path -> archive path); records what was done. Returns error texts. */
function relinkEntry(vault, entry, ledger, now) {
  const done = new Map((entry.relinked || []).map((x) => [x.file, x]));
  const errors = [];
  for (const rel of entry.relink || []) {
    if (done.has(rel)) continue;
    try { done.set(rel, { file: rel, count: rewriteNote(vault, rel, entry.from, entry.to, entry, ledger) }); }
    catch (e) {
      if (e.code === 'ENOENT') done.set(rel, { file: rel, count: 0, missing: true }); // the note is gone: nothing to fix
      else errors.push(`${rel}: ${e.message}`);
    }
  }
  entry.relinked = (entry.relink || []).filter((r) => done.has(r)).map((r) => done.get(r));
  if (errors.length) entry.relinkError = errors.join(' / ');
  else { delete entry.relinkError; entry.relinkedAt = now.toISOString(); }
  saveLedger(vault, ledger);
  return errors;
}

/** Before (and after) a run: finish the link rewrites of moves that stopped before them. Returns the entries touched. */
export function finishRelinks(vault, now = new Date()) {
  const ledger = readArchiveLedger(vault);
  const out = [];
  for (const e of ledger) {
    if (e.relinkAside) {
      try { settleRelinkAside(vault, e); } catch (err) { e.relinkError = err.message; saveLedger(vault, ledger); out.push(e); continue; }
      saveLedger(vault, ledger);
    }
    if (!e.relink?.length) continue;
    if (e.status === 'moved' && !e.relinkedAt) { relinkEntry(vault, e, ledger, now); out.push(e); }
    else if (e.status === 'undone' && !e.unrelinkedAt) { unrelinkEntry(vault, e, ledger, now); out.push(e); }
  }
  return out;
}

/** Undo's half: turn this entry's rewritten references back (every planned note; a crash may have left one unrecorded). */
function unrelinkEntry(vault, e, ledger, now) {
  const errs = [];
  for (const rel of e.relink || []) {
    try { rewriteNote(vault, rel, e.to, e.from, e, ledger); } catch (err) { if (err.code !== 'ENOENT') errs.push(`${rel}: ${err.message}`); }
  }
  if (errs.length) e.unrelinkError = errs.join(' / ');
  else { delete e.unrelinkError; e.unrelinkedAt = now.toISOString(); }
  saveLedger(vault, ledger);
  return errs;
}

/** Move one planned row (status ready or half). Returns { ok, error?, relinkErrors? }. opts.beforeUnlink: test hook. */
export function moveOne(vault, row, now = new Date(), opts = {}) {
  const fa = path.join(vault, row.from), ta = path.join(vault, row.to);
  const ledger = readArchiveLedger(vault);
  const hash = sha(fa);
  const entry = { proposalId: row.id, from: row.from, to: row.to, sha256: hash, bytes: fs.statSync(fa).size, status: 'moving', startedAt: now.toISOString(), ...(row.relink?.length ? { relink: [...row.relink] } : {}) };
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
    removeOldEntry(vault, entry, ledger, fa, ta);
    if (fs.existsSync(fa) || !fs.existsSync(ta) || sha(ta) !== hash) throw new Error('이동 뒤 확인 실패');
  } catch (e) {
    entry.status = 'failed'; entry.error = e.message;
    saveLedger(vault, ledger);
    return { ok: false, error: e.message };
  }
  entry.status = 'moved'; entry.movedAt = now.toISOString();
  saveLedger(vault, ledger);
  // Links next: a crash before they are done leaves relink without relinkedAt, finished by the next run (finishRelinks).
  const relinkErrors = entry.relink ? relinkEntry(vault, entry, ledger, now) : [];
  // The note has moved and the ledger says so; a failure closing the card is retried by the next run (status already).
  try { closeProposal(vault, row.id, row.to, now); } catch (e) { return { ok: false, error: `옮겼지만 제안을 닫지 못함: ${e.message}` }; }
  return { ok: true, relinkErrors };
}

/**
 * A note already at the archive path and gone from its place. When our own move did that but stopped before the ledger
 * said 'moved' (crash, or closing the card failed), the ledger entry is recovered (same hash) so undo still works.
 */
export function closeAlready(vault, row, now = new Date()) {
  const ledger = readArchiveLedger(vault);
  const mine = ledger.filter((e) => e.proposalId === row.id && e.from === row.from && e.to === row.to);
  if (mine.some((e) => e.aside)) throw new Error('이동 중 따로 둔 파일이 아직 정리되지 않아 완료로 닫지 않음');
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
  if (!dryRun) { recoverAside(vault, now); finishRelinks(vault, now); }
  const ps = (proposals || listProposals(vault, { status: 'approved' })).filter((p) => p.payload?.op === 'archive_note' && isApplicable(p))
    .sort((x, y) => String(x.createdAt).localeCompare(String(y.createdAt)) || String(x.payload.file).localeCompare(String(y.payload.file)));
  const plan = planArchive(vault, ps);
  const out = { plan, moved: [], already: [], skipped: [], errors: [] };
  if (dryRun) return out;
  for (const r of plan) {
    if (r.status === 'already') {
      try { closeAlready(vault, r, now); out.already.push(r); } catch (e) { out.errors.push({ ...r, error: e.message }); }
      continue;
    }
    if (!['ready', 'half'].includes(r.status)) { out.skipped.push(r); continue; }
    if (out.moved.length >= limit) { out.skipped.push({ ...r, reason: '이번 실행 상한(--limit) 밖' }); continue; }
    const m = moveOne(vault, r, now);
    if (m.ok) out.moved.push(r); else out.errors.push({ ...r, error: m.error });
    if (m.relinkErrors?.length) out.errors.push({ ...r, error: `옮겼지만 링크를 다 고치지 못함(다음 실행 때 다시): ${m.relinkErrors.join(' / ')}` });
  }
  finishRelinks(vault, now); // moves closed as «already» this run (a crash recovered) may still have links to fix
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
    saveLedger(vault, ledger);
    // Links rewritten for this move go back too; a failure stays recorded and finishRelinks retries it.
    if (e.relink?.length) unrelinkEntry(vault, e, ledger, now);
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
    if (r.relink?.length) L.push(`    경로 링크·경로 표기 고칠 노트 ${r.relink.length}개: ${r.relink.slice(0, 5).join(', ')}${r.relink.length > 5 ? ' …' : ''}`);
    if (r.links) L.push(`    링크: 이름 [[ ]] ${r.links.name} · 고칠 경로 링크 ${r.links.exact} · 막는 경로 링크 ${r.links.path + r.links.md} · attic 기록 ${r.links.attic} · 경로 언급(색인 등) ${r.links.pathMentions}${r.leavesPublic ? ' · 공개 재료 허용 목록에서 빠짐' : ''}`);
  }
  return L.join('\n');
}
