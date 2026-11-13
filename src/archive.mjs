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
import { spawnSync } from 'node:child_process';
import { requireVault } from './config.mjs';
import { atticPath, atticWritePath, ensureSkeleton, keepAsConflict, placeNoClobber, replaceNoteIfUnchanged, takeBackIfOurs, writeAtticJson } from './vault.mjs';
import { readJson } from './util.mjs';
import { getProposal, isApplicable, listProposals, saveProposal } from './proposals.mjs';

export const ARCHIVE_ROOT = '90_Archive';
/** Folders challengekim's public digest reads (VAULT_SETUP «collect-digest-material» allowlist): a moved note leaves it. */
export const PUBLIC_ALLOWLIST = ['10_Knowledge/References/', '00_Inbox/Read Later/'];
const SKIP_DIRS = new Set(['.git', '.obsidian', '.trash', 'node_modules']);
const ledgerRel = 'archive/ledger.json';

export const archiveTarget = (file) => `${ARCHIVE_ROOT}/${file}`;
const shaBuf = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sha = (abs) => shaBuf(fs.readFileSync(abs));
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
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const CONTAINER = /^(?: {0,3}(?:> ?|(?:[-*+]|\d{1,9}[.)])(?=[ \t]|$) ?))*/; // leading quote markers and list markers
// Lines that can interrupt a paragraph (CommonMark), so a code span cannot run on into them: an ATX heading, a bullet
// with content, an ordered item numbered 1 with content. Not «2.», an empty item or a quote line (they may continue).
const BLOCK_START = /^ {0,3}#{1,6}(\s|$)|^ {0,3}[-*+][ \t]+\S|^ {0,3}1[.)][ \t]+\S/;

/**
 * Inline code spans of one line (CommonMark: a backtick run closes at the next run of the same length).
 * `openAt` = where the first unclosed run is (-1: none): a span may start there and go on across the next lines.
 * Backticks inside a [[wikilink]] are the link's text and are skipped.
 */
function codeSpans(line, wikis = []) {
  // a backtick inside a [[wikilink]] is part of the link's text, not a code delimiter
  const runs = [...line.matchAll(/`+/g)].filter((m) => !wikis.some((w) => m.index > w.s && m.index < w.e)).map((m) => ({ s: m.index, n: m[0].length }));
  const out = [];
  let openAt = -1;
  for (let k = 0; k < runs.length; k++) {
    const c = runs.findIndex((r, j) => j > k && r.n === runs[k].n);
    if (c < 0) { if (openAt < 0) openAt = runs[k].s; continue; }
    out.push({ s: runs[k].s, e: runs[c].s + runs[c].n, n: runs[k].n, inner: line.slice(runs[k].s + runs[k].n, runs[c].s) });
    k = c;
  }
  return { spans: out, openAt };
}

/**
 * Regions rewriteRefs never edits: HTML code/comment blocks (<pre>, <code>, <!-- -->, <script>, <style>, <textarea>),
 * Obsidian %% comments, $$ math. regionAfter(line, open) = the region still open after this line (null = none), given
 * the one open before it; touches(line) = the line has any of these markers (then it is left alone as a whole).
 */
const REGIONS = [['<!--', '-->'], ['<pre', '</pre'], ['<code', '</code'], ['<script', '</script'], ['<style', '</style'], ['<textarea', '</textarea']];
const TOGGLES = ['%%', '$$'];
function regionAfter(line, open) {
  const low = line.toLowerCase();
  let i = 0;
  for (;;) {
    if (open) { // the marker that closes it, from here on
      const j = low.indexOf(open, i);
      if (j < 0) return open;
      i = j + open.length; open = null;
      continue;
    }
    // the earliest opener from here on
    let best = null;
    for (const [o, c] of REGIONS) { const j = low.indexOf(o, i); if (j >= 0 && (!best || j < best.j)) best = { j, len: o.length, close: c }; }
    for (const t of TOGGLES) { const j = low.indexOf(t, i); if (j >= 0 && (!best || j < best.j)) best = { j, len: t.length, close: t }; }
    if (!best) return null;
    open = best.close; i = best.j + best.len;
  }
}
const touches = (line) => /<!--|-->|<\/?(pre|code|script|style|textarea)\b|%%|\$\$/i.test(line);

/**
 * Rewrite the references to one note's full vault path from `fromRel` to `toRel` (both .md paths), and nothing else:
 *   - [[wikilinks]] whose target is exactly that path (with or without .md or a leading /): only the target changes,
 *     the alias, heading, block, embed ! and a table's \| stay;
 *   - an inline code span that is exactly that .md path (`` `10_Knowledge/…/x.md` ``, the wiki index's form).
 * Untouched: fenced code blocks (closed only by the same char, at least as long; also inside a quote or list item), any
 * line indented 4 spaces or a tab (after quote/list markers),
 * HTML code/comment regions, %% comments, $$ math (see regionAfter), other code spans (and wikilinks
 * inside them), anything a backtick run left open earlier in the same block may still be spanning (a `path` there stays
 * a stale mention; an exact link there blocks the move, see linkIndex), code spans inside a wikilink, bare text, URLs, other notes' links and aliases. Partial or
 * case-differing paths and markdown links block the move instead. Reversible: rewriteRefs(rewriteRefs(t, a, b).text,
 * b, a) gives t back unless t already spelled b. Returns { text, count }.
 */
export function rewriteRefs(text, fromRel, toRel) {
  const a = noExt(fromRel), b = noExt(toRel);
  let count = 0;
  let fence = null; // the open fence: { ch, len }
  let spanOpen = false; // an unclosed backtick run earlier in this paragraph: code spans here are not trusted
  // Regions we never touch, decided conservatively (a misread only skips a rewrite; linkIndex then blocks the move):
  // HTML code/comment blocks, Obsidian %% comments, $$ math. `region` = the marker that closes the open one.
  let region = null;
  const lines = text.split('\n').map((line) => {
    // Container markers (quote >, list items) come off first: a fence or indented code inside them is code too.
    const body = line.replace(CONTAINER, '');
    const f = FENCE_OPEN.exec(body);
    if (fence) {
      if (f && f[1][0] === fence.ch && f[1].length >= fence.len && /^ {0,3}(`+|~+)\s*$/.test(body)) fence = null;
      return line;
    }
    if (region || touches(line)) { region = regionAfter(line, region); spanOpen = false; return line; } // left as a whole
    if (!line.trim()) { spanOpen = false; return line; }
    // 4+ spaces or a tab: indented code, or a continuation we cannot tell from it — never touched.
    if (/^( {4}| {0,3}\t)/.test(body)) return line;
    if (f && !(f[1][0] === '`' && body.slice(f[0].length).includes('`'))) { fence = { ch: f[1][0], len: f[1].length }; spanOpen = false; return line; }
    if (BLOCK_START.test(line)) spanOpen = false; // a span never crosses into a new block
    const wikis = [...line.matchAll(WIKI)].map((m) => ({ s: m.index, e: m.index + m[0].length, m }));
    const { spans, openAt } = codeSpans(line, wikis);
    // A span crossing lines may hide a link or `path` inside it: only what ends before an open run is trusted.
    const before = spanOpen ? -1 : openAt < 0 ? Infinity : openAt;
    const trusted = (x) => x.e <= before;
    spanOpen = spanOpen || openAt >= 0;
    if (!line.includes(a)) return line;
    const inside = (x, ys) => ys.some((y) => x.s >= y.s && x.e <= y.e);
    const overlaps = (x, ys) => ys.some((y) => x.s < y.e && y.s < x.e);
    // A code span inside a wikilink is part of that link's text; a wikilink inside a code span is code, not a link.
    const items = [
      ...wikis.filter((w) => !inside(w, spans) && !spans.some((sp) => overlaps(w, [sp]) && !inside(sp, [w]))).map((w) => ({ ...w, kind: 'wiki' })),
      ...spans.filter((sp) => !inside(sp, wikis) && !overlaps(sp, wikis)).map((sp) => ({ ...sp, kind: 'code' })),
    ].sort((x, y) => x.s - y.s);
    let out = '', last = 0;
    for (const it of items) {
      out += line.slice(last, it.s);
      const orig = line.slice(it.s, it.e);
      if (it.kind === 'wiki') {
        const inner = it.m[1];
        if (trusted(it) && wikiTarget(inner) === a) {
          const i = inner.indexOf(a); // only blanks and slashes can come before it
          count++;
          out += orig.slice(0, orig.indexOf('[[') + 2) + inner.slice(0, i) + b + inner.slice(i + a.length) + ']]';
        } else out += orig;
      } else if (trusted(it) && it.n === 1 && it.inner === fromRel) { count++; out += '`' + toRel + '`'; } else out += orig;
      last = it.e;
    }
    return out + line.slice(last);
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
    const exactHere = new Set();
    for (const m of text.matchAll(WIKI)) {
      const target = wikiTarget(m[1]);
      if (!target) continue;
      if (target.includes('/')) {
        const t = target.toLowerCase();
        for (const [p, f] of byPath) if (p === t || p.endsWith('/' + t)) {
          const exact = editable && target === noExt(f);
          hit(f, exact ? 'exact' : 'path');
          if (exact && f !== rel) exactHere.add(f);
        }
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
    if (editable) for (const f of files) {
      if (!text.includes(noExt(f))) continue;
      const r = rewriteRefs(text, f, archiveTarget(f));
      if (r.count) want.get(f).relink.add(rel);
      // An exact link the rewrite leaves alone (it may sit inside code) would break: it blocks like any path link.
      if (exactHere.has(f)) {
        let left = 0;
        for (const m of r.text.matchAll(WIKI)) if (wikiTarget(m[1]) === noExt(f)) left++;
        if (left) { want.get(f).exact -= left; want.get(f).path += left; }
      }
    }
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
 * Rewrite one note's references for every [fromRel, toRel] pair in one swap: a regular UTF-8 file with no symlink on
 * the way and no second hard link, replaced only if it still reads the same as when we read it (vault.mjs
 * replaceNoteIfUnchanged). The swap is journaled on `holder` (a ledger entry). Returns the count per pair (all 0 =
 * nothing to do, nothing written).
 */
function rewriteNote(vault, rel, pairs, holder, ledger, now) {
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
  let t = text;
  const counts = pairs.map(([from, to]) => { const r = rewriteRefs(t, from, to); t = r.text; return r.count; });
  if (!counts.some(Boolean)) return counts;
  const hash = shaBuf(raw), newHash = shaBuf(Buffer.from(t, 'utf8'));
  const journal = (j) => {
    if (j) holder.relinkAside = { file: rel, tmp: posix(path.relative(vault, j.tmp)), aside: posix(path.relative(vault, j.aside)), sha256: hash, newSha256: newHash };
    else delete holder.relinkAside;
    saveLedger(vault, ledger);
  };
  replaceNoteIfUnchanged(abs, raw, t, { mode: st.mode & 0o777, journal, retire: keeper(vault, holder, ledger, now, rel) });
  return counts;
}

/**
 * Files that were once at a note's path are never unlinked right away (a writer that opened one earlier may still
 * write to it): they move to _attic/archive/relink-kept/ with the content we checked, recorded on `holder` first.
 * pruneKept, after KEEP_MS: drops one another name still links; keeps one any process holds open (or when lsof cannot
 * tell); otherwise drops it if the content is still that, else makes it a visible conflict note next to the note.
 */
const KEPT_DIR = 'archive/relink-kept';
const KEEP_MS = 10 * 60 * 1000;
function keeper(vault, holder, ledger, now, rel) {
  return (file, sha256) => {
    const krel = `${KEPT_DIR}/${crypto.randomBytes(8).toString('hex')}.kept`; // not .md: Obsidian and the link scan skip it
    const dest = atticWritePath(vault, krel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    holder.relinkKept = [...(holder.relinkKept || []), { kept: `_attic/${krel}`, file: rel, sha256: sha256 || null, at: now.toISOString() }];
    saveLedger(vault, ledger); // recorded first: a crash before the rename leaves a record whose file is missing (dropped)
    fs.renameSync(file, dest);
  };
}
/**
 * Does any process still hold `abs` open? true / false, or null when lsof cannot tell. A kept file has a random name
 * under _attic that no editor opens anew, so only a handle opened before can write to it: none now means none later.
 */
function heldOpen(abs) {
  const r = spawnSync('lsof', ['-t', '--', abs], { encoding: 'utf8', timeout: 30000 });
  if (r.error || r.signal) return null;
  if (r.status === 0 && r.stdout.trim()) return true;
  if (r.status === 1 && !r.stdout.trim()) return false;
  return null;
}
function pruneKept(vault, ledger, now) {
  const notes = [];
  for (const e of ledger) {
    if (!e.relinkKept?.length) continue;
    const keep = [];
    for (const k of e.relinkKept) {
      if (now - new Date(k.at) < KEEP_MS) { keep.push(k); continue; }
      try {
        if (typeof k.kept !== 'string' || !new RegExp(`^_attic/${KEPT_DIR}/[0-9a-f]{16}\\.kept$`).test(k.kept)) throw new Error('원장의 보관 사본 경로가 올바르지 않음');
        const abs = atticWritePath(vault, k.kept.slice('_attic/'.length));
        const st = statL(abs);
        if (!st) continue; // never got there, or already handled
        if (st.nlink > 1) { fs.unlinkSync(abs); continue; } // another name keeps these bytes; that name is judged on its own
        if (heldOpen(abs) !== false) { keep.push(k); continue; } // a writer may still write to it (or we cannot tell)
        if (k.sha256 && sha(abs) === k.sha256) { fs.unlinkSync(abs); continue; } // no writer left: the content is final
        if (badRel(vault, k.file)) throw new Error('원장의 노트 경로가 올바르지 않음');
        notes.push(keepAsConflict(abs, path.join(vault, k.file)));
      } catch (err) { k.error = err.message; keep.push(k); }
    }
    if (keep.length) e.relinkKept = keep; else delete e.relinkKept;
  }
  saveLedger(vault, ledger);
  return notes;
}

/**
 * A link rewrite that stopped mid-swap (see vault.mjs replaceNoteIfUnchanged), settled by CONTENT, never by inode, and
 * without overwriting or unlinking anything that was at the path:
 *   - the temp name is retired (as ours if its content is still ours; otherwise kept until pruneKept sees it);
 *   - an unchanged original goes back to an empty path, else it is retired (the note there is ours or newer);
 *   - an edited original goes back when the path is empty or holds exactly our text (taken back first), and is
 *     otherwise kept as a visible conflict note next to the note, which stays as the user left it.
 */
function settleRelinkAside(vault, holder, ledger, now) {
  const j = holder.relinkAside;
  const inVault = (rel) => (typeof rel === 'string' && !badRel(vault, rel) ? path.join(vault, rel) : null);
  const abs = inVault(j.file), aside = inVault(j.aside), tmp = inVault(j.tmp);
  if (!abs || !aside || !tmp || path.dirname(aside) !== path.dirname(abs) || path.dirname(tmp) !== path.dirname(abs)
    || !/^\.attic-relink-[0-9a-f]+\.orig$/.test(path.basename(aside)) || !/^\.attic-relink-[0-9a-f]+\.tmp$/.test(path.basename(tmp))) {
    throw new Error('원장의 링크 고침 기록이 올바르지 않음 — 직접 확인 필요');
  }
  const retire = keeper(vault, holder, ledger, now, j.file);
  const isOurs = (b) => typeof j.newSha256 === 'string' && shaBuf(b) === j.newSha256;
  if (statL(tmp)) retire(tmp, isOurs(fs.readFileSync(tmp)) ? j.newSha256 : null);
  if (statL(aside)) {
    if (sha(aside) === j.sha256) { if (!placeNoClobber(aside, abs)) retire(aside, j.sha256); }
    else if (!(takeBackIfOurs(abs, isOurs, retire) && placeNoClobber(aside, abs))) keepAsConflict(aside, abs);
  }
  delete holder.relinkAside;
  saveLedger(vault, ledger);
}
function badRel(vault, rel) {
  const parts = rel.split('/');
  return !rel || path.isAbsolute(rel) || parts.some((p) => !p || p === '.' || p === '..') || ['_attic', ARCHIVE_ROOT].includes(parts[0]) || !!symlinkOnTarget(vault, rel);
}

/**
 * Rewrite the references for these ledger entries, each referencing note once for all of them (one swap per note, not
 * one per moved note). back=false: old path -> archive path for moved entries, recorded per note in `relinked` and
 * closed with relinkedAt; back=true: the reverse for undone entries, closed with unrelinkedAt. Failures are recorded
 * (relinkError / unrelinkError) and retried by the next run.
 */
function relinkBatch(vault, ledger, entries, now, back = false) {
  const byNote = new Map();
  for (const e of entries) {
    const done = new Set(back ? [] : (e.relinked || []).map((x) => x.file));
    for (const rel of e.relink || []) if (!done.has(rel)) { if (!byNote.has(rel)) byNote.set(rel, []); byNote.get(rel).push(e); }
  }
  const errs = new Map();
  const fail = (e, msg) => errs.set(e, [...(errs.get(e) || []), msg]);
  for (const [rel, es] of byNote) {
    // An unsettled swap of this note waits for finishRelinks; the journal goes on an entry not holding another one.
    const holder = es.find((e) => !e.relinkAside);
    if (!holder || ledger.some((e) => e.relinkAside?.file === rel)) { for (const e of es) fail(e, `${rel}: 이전 링크 고침이 아직 정리되지 않음`); continue; }
    let counts;
    try { counts = rewriteNote(vault, rel, es.map((e) => (back ? [e.to, e.from] : [e.from, e.to])), holder, ledger, now); }
    catch (err) {
      if (err.code === 'ENOENT') counts = null; // the note is gone: nothing to fix
      else { for (const e of es) fail(e, `${rel}: ${err.message}`); continue; }
    }
    if (!back) es.forEach((e, i) => { e.relinked = [...(e.relinked || []), counts ? { file: rel, count: counts[i] } : { file: rel, count: 0, missing: true }]; });
    saveLedger(vault, ledger);
  }
  const [errKey, atKey] = back ? ['unrelinkError', 'unrelinkedAt'] : ['relinkError', 'relinkedAt'];
  for (const e of entries) {
    if (errs.has(e)) e[errKey] = errs.get(e).join(' / ');
    else { delete e[errKey]; e[atKey] = now.toISOString(); }
  }
  saveLedger(vault, ledger);
}

/**
 * Every run and tick, before and after moving: settle swaps that stopped midway, rewrite the links of moved notes not
 * yet relinked and turn back those of undone ones (batched), and prune the kept copies. Returns the entries touched.
 */
export function finishRelinks(vault, now = new Date()) {
  const ledger = readArchiveLedger(vault);
  const out = new Set();
  for (const e of ledger) {
    if (!e.relinkAside) continue;
    try { settleRelinkAside(vault, e, ledger, now); }
    catch (err) { e.relinkError = `멈춘 링크 고침 정리 실패: ${err.message}`; saveLedger(vault, ledger); out.add(e); }
  }
  const fwd = ledger.filter((e) => e.relink?.length && e.status === 'moved' && !e.relinkedAt);
  const bwd = ledger.filter((e) => e.relink?.length && e.status === 'undone' && !e.unrelinkedAt);
  if (fwd.length) relinkBatch(vault, ledger, fwd, now);
  if (bwd.length) relinkBatch(vault, ledger, bwd, now, true);
  pruneKept(vault, ledger, now);
  return [...out, ...fwd, ...bwd];
}

/** The link-fix errors still recorded for these proposals' moves (shown after a run or tick). */
export function relinkErrorsFor(vault, ids) {
  return readArchiveLedger(vault).filter((e) => ids.includes(e.proposalId) && e.status === 'moved' && e.relinkError)
    .map((e) => ({ id: e.proposalId, error: `옮겼지만 링크를 다 고치지 못함(다음 실행 때 다시): ${e.relinkError}` }));
}

/** Move one planned row (status ready or half). Returns { ok, error? }. Links: finishRelinks. opts.beforeUnlink: test hook. */
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
  // Links next, batched for the whole run by finishRelinks (the caller runs it after its moves; a crash leaves relink
  // without relinkedAt, finished by the next run).
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
  }
  finishRelinks(vault, now); // the links of this run's moves, in one swap per referencing note
  const byId = new Map(out.moved.map((r) => [r.id, r]));
  for (const x of relinkErrorsFor(vault, [...byId.keys()])) out.errors.push({ ...byId.get(x.id), error: x.error });
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
    // Links rewritten for this move go back too (batched below); a failure stays recorded and finishRelinks retries it.
    const p = getProposal(vault, e.proposalId);
    if (p) { p.archiveUndoneAt = now.toISOString(); saveProposal(vault, p); }
    out.restored.push(e);
  }
  saveLedger(vault, ledger);
  const back = out.restored.filter((e) => e.relink?.length);
  if (back.length) relinkBatch(vault, ledger, back, now, true);
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
