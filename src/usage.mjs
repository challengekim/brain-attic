// Usage signals for triage: how widely is a piece of knowledge actually used?
//   backlinks = number of OTHER vault notes that link to it with [[...]]
//   projects  = number of projects (repos listed in the projects file / config.triage.projectPaths) whose text files mention it
// Deterministic code only (regex + file walk). Symlinks are never followed, and every walk has a hard cap.
import fs from 'node:fs';
import path from 'node:path';
import { expandHome } from './config.mjs';

export const BACKLINK_HOT = 3; // "linked often" threshold used in the prompt wording
export const LIMITS = {
  vaultFiles: 5000, vaultFileBytes: 256 * 1024, vaultDepth: 8,
  projects: 20, projectFiles: 200, projectFileBytes: 100 * 1024, projectTotalBytes: 2 * 1024 * 1024, projectDepth: 6,
  minNeedle: 4,
};
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__', '_attic']);
const TEXT_EXT = new Set(['.md', '.mdx', '.txt', '.rst', '.json', '.yml', '.yaml', '.toml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.sh', '.html', '.css']);

/** Walk dir without following symlinks (Dirent.isFile/isDirectory are false for links). Sorted, capped. */
function walk(root, { exts, maxFiles, maxDepth, skipAttic = false }) {
  const out = [];
  const rec = (d, depth) => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    ents.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
    for (const e of ents) {
      if (out.length >= maxFiles) return;
      if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) rec(p, depth + 1);
      else if (e.isFile() && exts.has(path.extname(e.name).toLowerCase())) out.push(p);
    }
  };
  rec(root, 0);
  return out;
}

function readCapped(file, maxBytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    const n = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

const norm = (s) => String(s).trim().replace(/\.md$/i, '').split(/[\\/]/).pop().trim().toLowerCase();
const LINK_RE = /\[\[([^\]\n|#]+)(?:#[^\]\n|]*)?(?:\|[^\]\n]*)?\]\]/g;

/** Map normalized link target -> Set of vault-relative source files that link to it. */
export function scanBacklinks(vault, limits = LIMITS) {
  const map = new Map();
  for (const f of walk(vault, { exts: new Set(['.md']), maxFiles: limits.vaultFiles, maxDepth: limits.vaultDepth })) {
    const text = readCapped(f, limits.vaultFileBytes);
    if (!text.includes('[[')) continue;
    const rel = path.relative(vault, f);
    for (const m of text.matchAll(LINK_RE)) {
      const key = norm(m[1]);
      if (!key) continue;
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(rel);
    }
  }
  return map;
}

/** Project roots from config.triage.projectPaths and from path tokens (~/x or /x) in the projects file lines. */
export function projectRoots(ctx, projectLines = []) {
  const found = new Map(); // abs path -> display name
  const add = (p, name) => {
    const abs = path.resolve(expandHome(p, ctx.env));
    let st;
    try { st = fs.lstatSync(abs); } catch { return; }
    if (!st.isDirectory()) return; // a symlinked root is not a directory here: links are never followed
    if (!found.has(abs)) found.set(abs, name || path.basename(abs));
  };
  const cfg = ctx.config.triage?.projectPaths;
  if (Array.isArray(cfg)) { for (const p of cfg) if (typeof p === 'string') add(p); }
  else if (cfg && typeof cfg === 'object') { for (const [n, p] of Object.entries(cfg)) if (typeof p === 'string') add(p, n); }
  for (const line of projectLines) {
    for (const m of line.matchAll(/(?:^|[\s`(])((?:~|)\/[^\s`)]+)/g)) {
      const tok = m[1].replace(/[.,;]+$/, '');
      if (tok.startsWith('~/') || tok.startsWith('/')) add(tok, line.split(/\s+[—-]\s+/)[0].trim().slice(0, 60));
    }
  }
  return [...found.entries()].slice(0, LIMITS.projects).map(([dir, name]) => ({ dir, name }));
}

/** Needles that identify an item in someone else's text: file basename, title, url. Too-short strings are dropped. */
export function needlesOf(item, minLen = LIMITS.minNeedle) {
  const set = new Set();
  const add = (s) => { s = String(s || '').trim().toLowerCase(); if (s.length >= minLen) set.add(s); };
  if (item.file) add(path.basename(item.file, '.md'));
  add(item.title);
  add(item.url);
  return [...set];
}

/**
 * items -> Map(id -> {backlinks, projects, projectNames}). Only counts are returned; nothing from other files is kept.
 */
export function computeUsage(ctx, items, { projectLines = [], limits = LIMITS } = {}) {
  const out = new Map();
  const backMap = scanBacklinks(ctx.vault, limits);
  const roots = projectRoots(ctx, projectLines);
  const names = new Map(roots.map((r) => [r.dir, r.name]));
  const needles = items.map((it) => needlesOf(it, limits.minNeedle));
  const hits = items.map(() => new Set()); // project roots (absolute dirs) per item; display names are kept apart
  for (const { dir, name } of roots) {
    const files = walk(dir, { exts: TEXT_EXT, maxFiles: limits.projectFiles, maxDepth: limits.projectDepth });
    let budget = limits.projectTotalBytes;
    const pending = new Set(items.map((_, i) => i).filter((i) => needles[i].length));
    for (const f of files) {
      if (!pending.size || budget <= 0) break;
      const text = readCapped(f, Math.min(limits.projectFileBytes, budget)).toLowerCase();
      budget -= text.length;
      for (const i of [...pending]) {
        if (needles[i].some((n) => text.includes(n))) { hits[i].add(dir); pending.delete(i); }
      }
    }
  }
  items.forEach((it, i) => {
    const srcs = new Set();
    // Backlinks only make sense for notes that live in the vault (feed items have no note to link to).
    const keys = new Set(it.file ? [norm(it.file), norm(it.title || '')].filter(Boolean) : []);
    for (const k of keys) for (const s of backMap.get(k) || []) if (s !== it.file) srcs.add(s);
    out.set(it.id, { backlinks: srcs.size, projects: hits[i].size, projectNames: [...hits[i]].map((d) => names.get(d)).sort() });
  });
  return out;
}
