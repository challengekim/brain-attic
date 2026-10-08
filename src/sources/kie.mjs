// kie.ai has no public model JSON. We snapshot the documentation index (llms.txt) instead.
const SKIP = /\/(cn|zh|ja|ko|es|fr|de|ru|pt|ar|tr)\//; // translated duplicates

/** Parse lines like `- Image Models > Flux Kontext API [Title](https://docs.kie.ai/x.md): desc`. */
export function parseLlmsTxt(text) {
  const docs = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^-\s+(?:(.*?)\s*)?\[(.+?)\]\((https?:\/\/[^)\s]+)\)/.exec(line);
    if (!m || SKIP.test(m[3])) continue;
    const category = (m[1] || '').replace(/\s+/g, ' ').trim();
    docs[m[3]] = { category, title: m[2].trim() };
  }
  return docs;
}
export function toSnapshot(text, now = new Date()) {
  const docs = parseLlmsTxt(text);
  return { fetchedAt: now.toISOString(), count: Object.keys(docs).length, docs };
}
export function diffSnapshots(prev, cur) {
  const added = [];
  for (const [url, d] of Object.entries(cur.docs)) if (!prev.docs[url]) added.push({ url, ...d });
  return { added };
}
export function capabilitiesOf(text) {
  const t = text.toLowerCase(); const caps = [];
  if (/image|flux|imagen|seedream/.test(t)) caps.push('image');
  if (/video|veo|runway|kling|sora|seedance/.test(t)) caps.push('video');
  if (/music|audio|suno|speech|tts|voice|eleven/.test(t)) caps.push('audio');
  return caps;
}
