// OpenRouter public model list (no auth). Snapshot + diff.
const NON_TEXT = ['image', 'audio', 'video'];
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) && n >= 0 ? n : null; };

export function toSnapshot(json, now = new Date()) {
  const models = {};
  for (const m of json?.data || []) {
    if (!m?.id) continue;
    models[m.id] = {
      name: m.name || m.id,
      created: m.created || null,
      in: m.architecture?.input_modalities || [],
      out: m.architecture?.output_modalities || [],
      prompt: num(m.pricing?.prompt),
      completion: num(m.pricing?.completion),
    };
  }
  return { fetchedAt: now.toISOString(), count: Object.keys(models).length, models };
}

const pct = (a, b) => (a === null || b === null ? null : (a === 0 ? (b === 0 ? 0 : Infinity) : (b - a) / a));

/** diff(prev, cur) -> { added, priceChanges, newModalities } */
export function diffSnapshots(prev, cur, threshold = 0.2) {
  const added = [], priceChanges = [], newModalities = [];
  for (const [id, m] of Object.entries(cur.models)) {
    const p = prev.models[id];
    if (!p) { added.push({ id, name: m.name, out: m.out, prompt: m.prompt, completion: m.completion, nonText: m.out.filter((x) => NON_TEXT.includes(x)) }); continue; }
    for (const field of ['prompt', 'completion']) {
      const ch = pct(p[field], m[field]);
      if (ch !== null && Math.abs(ch) >= threshold && !(p[field] === 0 && m[field] === 0)) {
        priceChanges.push({ id, name: m.name, field, from: p[field], to: m[field], change: ch });
      }
    }
    const gained = m.out.filter((x) => NON_TEXT.includes(x) && !p.out.includes(x));
    if (gained.length) newModalities.push({ id, name: m.name, gained });
  }
  return { added, priceChanges, newModalities };
}
