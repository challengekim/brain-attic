// attic audit: scan skills/scripts for model IDs and CLI tools, cross-check with radar events,
// and suggest IMPROVEMENT CANDIDATES. It never proposes plain model-name substitution -- that is a different tool's job.
import fs from 'node:fs';
import path from 'node:path';
import { expandHome, requireVault } from './config.mjs';
import { recentEvents } from './radar.mjs';

const EXTS = new Set(['.md', '.sh', '.mjs', '.py', '.toml', '.json']);
const VENDORS = ['anthropic', 'openai', 'google', 'meta-llama', 'mistralai', 'deepseek', 'qwen', 'x-ai', 'cohere', 'perplexity', 'nvidia', 'amazon', 'microsoft', 'moonshotai', 'z-ai', 'minimax', 'black-forest-labs', 'bytedance', 'stability-ai'];
const MODEL_RES = [
  /\bclaude-[a-z0-9][a-z0-9.\-]*/gi,
  /\bgpt-[a-z0-9][a-z0-9.\-]*/gi,
  /\bgemini-[a-z0-9][a-z0-9.\-]*/gi,
  new RegExp(`\\b(?:${VENDORS.join('|')})/[a-z0-9][a-z0-9._:\\-]*`, 'gi'),
];
const TOOLS = ['ffmpeg', 'yt-dlp', 'whisper', 'pandoc', 'magick', 'imagemagick', 'sox', 'playwright', 'puppeteer', 'gh', 'vercel', 'supabase', 'railway', 'aws', 'gws', 'claude', 'codex', 'aside', 'ollama', 'jq'];
const CAPS = {
  image: /image|이미지|imagen|dall-?e|flux|nano.?banana|thumbnail|썸네일|diffusion/i,
  video: /video|영상|비디오|veo|sora|kling|runway/i,
  audio: /audio|tts|speech|voice|음성|오디오|whisper|music|음악/i,
};

const clean = (s) => s.replace(/[.\-:]+$/, '');

export function scanText(text) {
  const models = new Set(), tools = new Set();
  for (const re of MODEL_RES) for (const m of text.matchAll(re)) { const id = clean(m[0]); if (id.length > 4) models.add(id); }
  for (const t of TOOLS) if (new RegExp(`(?<![\\w./-])${t.replace(/[-]/g, '\\-')}(?![\\w-])`, 'i').test(text)) tools.add(t);
  return { models: [...models], tools: [...tools], caps: capsOf(text) };
}
const capsOf = (text) => Object.entries(CAPS).filter(([, re]) => re.test(text)).map(([k]) => k);
const HEADER_LINES = 15; // a loose script says what it is for in its leading comment/docstring

// Deleted, archived or hidden things are not "what I use": skills/.trash/<ts>/..., _archive/, disabled-foo/, .cache/ ...
export const isSkippedDir = (name) => name === 'node_modules' || name.startsWith('.') || /^_?archive[sd]?$/i.test(name) || /^disabled/i.test(name);

/** The declared purpose of a skill: SKILL.md frontmatter name + description (whole text when there is no frontmatter). */
export function purposeText(text) {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fm) return text;
  const out = [];
  let inKey = false;
  for (const line of fm[1].split(/\r?\n/)) {
    const top = /^([A-Za-z_][\w-]*):/.exec(line);
    if (top) inKey = ['name', 'description'].includes(top[1]);
    if (inKey) out.push(line);
  }
  return out.join('\n');
}

export function scanDir(root, { maxFiles = 3000, maxBytes = 1_000_000 } = {}) {
  const files = [];
  const walk = (d, depth) => {
    if (depth > 6 || files.length >= maxFiles) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name.startsWith('.') || (e.isDirectory() && isSkippedDir(e.name))) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && EXTS.has(path.extname(e.name))) {
        try {
          if (fs.statSync(p).size > maxBytes) continue;
          const text = fs.readFileSync(p, 'utf8');
          const rec = { file: p, rel: path.join(path.basename(root), path.relative(root, p)), ...scanText(text) };
          if (/^skill\.md$/i.test(e.name)) rec.purposeCaps = capsOf(purposeText(text));
          else if (d === root) rec.purposeCaps = capsOf(text.split('\n', HEADER_LINES).join('\n'));
          files.push(rec);
        } catch { /* unreadable */ }
      }
    }
  };
  walk(root, 0);
  return files;
}

/**
 * The unit a suggestion is about: the nearest dir holding a SKILL.md (skills/synced/<id>/pdf), else `<root>/<name>`
 * for anything inside a package dir (skills/foo/...), else the loose file itself (scripts/x.sh).
 */
export function groupOf(rel, skillDirs = new Set()) {
  const parts = rel.split(/[\\/]/);
  for (let i = parts.length - 1; i >= 2; i--) { const dir = parts.slice(0, i).join('/'); if (skillDirs.has(dir)) return dir; }
  return parts.length > 2 ? parts.slice(0, 2).join('/') : parts.join('/');
}

/**
 * Files -> one entry per skill/package. caps = the declared purpose only: SKILL.md frontmatter, else README.md, else a
 * loose file's header. A Google Workspace helper that mentions "image" somewhere is not an image skill, and a folder
 * that declares nothing (a sync cache, a pile of scripts) gets no capability match at all.
 */
export function groupFiles(files) {
  const rels = (f) => f.rel.split(/[\\/]/);
  const skillDirs = new Set(files.filter((f) => /^skill\.md$/i.test(rels(f).at(-1))).map((f) => rels(f).slice(0, -1).join('/')));
  const groups = new Map();
  for (const f of files) {
    const key = groupOf(f.rel, skillDirs);
    let g = groups.get(key);
    if (!g) groups.set(key, g = { group: key, files: [], models: new Set(), declared: null });
    g.files.push(f);
    for (const m of f.models) g.models.add(m);
    const base = rels(f).slice(key.split('/').length).join('/');
    if (key === rels(f).join('/')) g.declared = f.purposeCaps || f.caps; // a loose file is its own group
    else if (/^skill\.md$/i.test(base)) g.declared = f.purposeCaps || f.caps;
    else if (/^readme\.md$/i.test(base) && !g.declared) g.declared = f.caps;
  }
  return [...groups.values()].map((g) => ({ group: g.group, files: g.files, models: [...g.models], caps: g.declared || [] }));
}

const EXAMPLES = 3;
const exampleText = (g, list) => {
  const names = list.slice(0, EXAMPLES).map((f) => f.rel.split(/[\\/]/).slice(g.group.split('/').length).join('/')).filter(Boolean);
  return names.length ? ` (파일 ${list.length}개, 예: ${names.join(', ')})` : '';
};

const NAMES = 3;
const what = (ev) => ev.source === 'kie' ? `kie.ai 에 "${ev.name}" 문서가 새로 생겼다` : `\`${ev.id}\` 가 새로 나왔다 (${ev.detail})`;
const whatMany = (cap, evs) => `${cap} 쪽에 새로 나온 것 ${evs.length}건 — ${evs.slice(0, NAMES).map((e) => e.source === 'kie' ? `"${e.name}"(kie.ai)` : `\`${e.id}\``).join(', ')}${evs.length > NAMES ? ` 외 ${evs.length - NAMES}건` : ''}`;

/**
 * Pure: files (scan results) x radar events -> suggestions. One card per skill/package and capability (new models and
 * docs of that kind listed together, never one card per file or per doc), one per skill and model for a price drop.
 */
export function suggest(files, events, { limit = 10 } = {}) {
  const groups = groupFiles(files);
  const out = [];
  const byKey = new Map();
  const seenEv = new Set();
  for (const ev of events) {
    if (ev.kind === 'price_rise' || seenEv.has(ev.key)) continue;
    seenEv.add(ev.key);
    const caps = ev.capabilities || [];
    const id = ev.id.toLowerCase();
    if (ev.kind === 'price_drop') {
      for (const g of groups) {
        const using = g.files.filter((f) => f.models.some((m) => m.toLowerCase() === id || id.endsWith('/' + m.toLowerCase())));
        if (!using.length) continue;
        out.push({ file: g.group, files: using.slice(0, EXAMPLES).map((f) => f.rel), eventKey: ev.key, eventKeys: [ev.key], capability: null,
          text: `\`${g.group}\`${exampleText(g, using)} 가 쓰는 \`${ev.id}\` 의 가격이 내렸다 (${ev.detail}). 지금 쓰는 방식이 이 가격에서도 최선인지 다시 볼까?` });
      }
      continue;
    }
    if (!caps.length) continue; // text-only new model = plain substitution territory -> no suggestion
    for (const g of groups) {
      const cap = caps.find((c) => g.caps.includes(c));
      if (!cap) continue;
      if (g.models.some((m) => m.toLowerCase() === id)) continue;
      const k = `${g.group}\u0000${cap}`;
      let s = byKey.get(k);
      if (!s) {
        const list = g.files.filter((f) => f.caps.includes(cap));
        byKey.set(k, s = { file: g.group, files: (list.length ? list : g.files).slice(0, EXAMPLES).map((f) => f.rel), capability: cap, g, evs: [] });
        out.push(s);
      }
      s.evs.push(ev);
    }
  }
  return out.slice(0, limit).map((s) => {
    if (!s.evs) return s;
    const { g, evs, ...rest } = s;
    const using = g.models.slice(0, 3).join(', ');
    return { ...rest, eventKey: evs[0].key, eventKeys: evs.map((e) => e.key),
      text: `\`${g.group}\` 가 ${s.capability} 관련 작업을 하는 것으로 보인다${using ? ` (언급된 모델: ${using})` : ''}. ${evs.length === 1 ? what(evs[0]) : whatMany(s.capability, evs)} — 시도해 볼까?` };
  });
}

export async function audit(ctx, { now = new Date() } = {}) {
  const vault = requireVault(ctx);
  const paths = (ctx.config.audit?.paths || []).map((p) => path.resolve(expandHome(p, ctx.env)));
  // audit.exclude: prefixes of the scanned paths as shown in suggestions (e.g. "skills/synced" = skills an app syncs in).
  const excluded = (ctx.config.audit?.exclude || []).filter((x) => typeof x === 'string' && x.trim()).map((x) => x.replace(/^\/+|\/+$/g, '') + '/');
  const files = paths.flatMap((p) => scanDir(p)).filter((f) => !excluded.some((x) => (f.rel.split(path.sep).join('/') + '/').startsWith(x)));
  const models = {}, tools = {};
  for (const f of files) {
    for (const m of f.models) (models[m] ||= []).push(f.rel);
    for (const t of f.tools) (tools[t] ||= []).push(f.rel);
  }
  const events = recentEvents(vault, 7, now);
  const suggestions = suggest(files, events);
  return { scannedFiles: files.length, models, tools, events: events.length, suggestions };
}
