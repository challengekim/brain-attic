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
  const caps = Object.entries(CAPS).filter(([, re]) => re.test(text)).map(([k]) => k);
  return { models: [...models], tools: [...tools], caps };
}

export function scanDir(root, { maxFiles = 3000, maxBytes = 1_000_000 } = {}) {
  const files = [];
  const walk = (d, depth) => {
    if (depth > 6 || files.length >= maxFiles) return;
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && EXTS.has(path.extname(e.name))) {
        try {
          if (fs.statSync(p).size > maxBytes) continue;
          const s = scanText(fs.readFileSync(p, 'utf8'));
          files.push({ file: p, rel: path.join(path.basename(root), path.relative(root, p)), ...s });
        } catch { /* unreadable */ }
      }
    }
  };
  walk(root, 0);
  return files;
}

/** Pure: files (scan results) x radar events -> suggestions. */
export function suggest(files, events, { limit = 10 } = {}) {
  const out = [];
  const seen = new Set();
  const push = (s) => { const k = `${s.file}|${s.eventKey}`; if (!seen.has(k)) { seen.add(k); out.push(s); } };
  for (const ev of events) {
    if (ev.kind === 'price_rise') continue;
    const caps = ev.capabilities || [];
    if (ev.kind === 'price_drop') {
      for (const f of files) {
        if (f.models.some((m) => m.toLowerCase() === ev.id.toLowerCase() || ev.id.toLowerCase().endsWith('/' + m.toLowerCase()))) {
          push({ file: f.rel, eventKey: ev.key, capability: null,
            text: `\`${f.rel}\` 가 쓰는 \`${ev.id}\` 의 가격이 내렸다 (${ev.detail}). 지금 쓰는 방식이 이 가격에서도 최선인지 다시 볼까?` });
        }
      }
      continue;
    }
    if (!caps.length) continue; // text-only new model = plain substitution territory -> no suggestion
    for (const cap of caps) {
      for (const f of files) {
        if (!f.caps.includes(cap)) continue;
        if (f.models.some((m) => m.toLowerCase() === ev.id.toLowerCase())) continue;
        const using = f.models.slice(0, 3).join(', ');
        push({ file: f.rel, eventKey: ev.key, capability: cap,
          text: `\`${f.rel}\` 가 ${cap} 관련 작업을 하는 것으로 보인다${using ? ` (언급된 모델: ${using})` : ''}. ${ev.source === 'kie' ? `kie.ai 에 "${ev.name}" 문서가 새로 생겼다` : `\`${ev.id}\` 가 새로 나왔다 (${ev.detail})`} — 시도해 볼까?` });
      }
    }
  }
  return out.slice(0, limit);
}

export async function audit(ctx, { now = new Date() } = {}) {
  const vault = requireVault(ctx);
  const paths = (ctx.config.audit?.paths || []).map((p) => path.resolve(expandHome(p, ctx.env)));
  const files = paths.flatMap((p) => scanDir(p));
  const models = {}, tools = {};
  for (const f of files) {
    for (const m of f.models) (models[m] ||= []).push(f.rel);
    for (const t of f.tools) (tools[t] ||= []).push(f.rel);
  }
  const events = recentEvents(vault, 7, now);
  const suggestions = suggest(files, events);
  return { scannedFiles: files.length, models, tools, events: events.length, suggestions };
}
