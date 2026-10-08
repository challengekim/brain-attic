// attic review: triage + audit + radar -> approval sheet _attic/reviews/YYYY-Www.md, proposals, notifications.
import { requireVault } from './config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { atticPath, ensureSkeleton, listRecentMd, writeAttic } from './vault.mjs';
import { isoWeek, readJson } from './util.mjs';
import { triage } from './triage.mjs';
import { audit } from './audit.mjs';
import { recentEvents } from './radar.mjs';
import { createProposal, expireStale, listProposals, proposalId } from './proposals.mjs';
import { dispatch } from './notify/index.mjs';

const MAX_TEACH = 8;
/** b = "the system should apply this". Each one is a question to a human, so cap them per week. */
export const MAX_AUTO = 5;
export const SHEET_B_MAX = 15;

/** Where a triage item's text may later be read from: a vault note, a web link, or just its title. */
export function kindOfItem(i) {
  if (i.file) return 'vault';
  return /^https?:\/\//i.test(String(i.url || '')) ? 'url' : 'topic';
}

/** True when this week's saved triage should not be reused (failed run, empty, or inputs changed after it). */
export function triageIsStale(ctx, vault, saved) {
  if (!saved || !Array.isArray(saved.items)) return true;
  if ((saved.errors || []).length || saved.items.length === 0) return true;
  const since = Date.parse(saved.generatedAt);
  if (!Number.isFinite(since)) return true;
  const inbox = atticPath(vault, 'inbox');
  try {
    for (const n of fs.readdirSync(inbox)) if (/\.md$/.test(n) && fs.statSync(path.join(inbox, n)).mtimeMs > since) return true;
  } catch { /* no inbox */ }
  for (const folder of ctx.config.triage?.include || []) {
    const dir = path.isAbsolute(folder) ? folder : path.join(vault, folder);
    if (listRecentMd(dir, { sinceMs: since + 1 }).length) return true;
  }
  return false;
}

export function buildDescriptors(tri, aud) {
  const out = [];
  const cs = tri.items.filter((i) => i.class === 'c').slice(0, MAX_TEACH);
  for (const c of cs) {
    out.push({
      kind: 'teach',
      summary: [`깊게 읽고 설명해 볼 것: ${c.title}`, `이유: ${c.reason}`, `예상 ${c.minutes}분${c.project ? ` · 프로젝트: ${c.project}` : ''}`],
      payload: { op: 'queue_teach', title: c.title, url: c.url, kind: kindOfItem(c), ...(c.file ? { file: c.file } : {}), project: c.project, minutes: c.minutes },
    });
  }
  for (const b of tri.items.filter((i) => i.class === 'b').slice(0, MAX_AUTO)) {
    out.push({
      kind: 'auto',
      summary: [`자동 적용 후보 — 이 업데이트/변경을 시스템에 반영할까요? ${b.title}`, `이유: ${b.reason}`],
      // Not whitelisted on purpose: apply only writes _attic/approved/<id>.prompt.md for a human to run.
      payload: { op: 'note_auto', title: b.title, url: b.url, kind: kindOfItem(b), ...(b.file ? { file: b.file } : {}), project: b.project },
    });
  }
  for (const s of aud.suggestions) {
    out.push({
      kind: 'improve',
      summary: [s.text],
      payload: { op: 'improve_candidate', file: s.file, capability: s.capability, eventKey: s.eventKey },
    });
  }
  return out;
}

export function renderSheet({ vault, week, tri, aud, events, descriptors, dryRun, nowIso }) {
  const L = [`# 승인 시트 ${week}`, '', `생성: ${nowIso}${dryRun ? ' (dry-run: 제안 저장·발송 안 함)' : ''}`, ''];
  L.push('## 1. 이번 주 레이더', '');
  if (!events.length) L.push('- 변화 없음 (또는 아직 기준선만 저장됨)');
  for (const e of events.slice(0, 40)) L.push(`- [${e.source}] \`${e.id}\` — ${e.detail}`);
  L.push('', '## 2. 분류 결과', '',
    `- a ${tri.counts.a} / b ${tri.counts.b} / c ${tri.counts.c} / 미분류 ${tri.counts.unclassified} — c 시간 ${tri.usedMinutes}/${tri.weeklyMinutes}분${tri.demoted ? ` (예산 초과로 a 강등 ${tri.demoted}건)` : ''}`);
  if (tri.errors.length) L.push(`- 러너 오류: ${tri.errors[0]} -> 해당 항목은 미분류로 남겼습니다 (지어내지 않음)`);
  for (const k of ['c', 'b', 'a']) {
    const rows = tri.items.filter((i) => i.class === k).slice(0, k === 'c' ? 30 : 15);
    if (!rows.length) continue;
    L.push('', `### ${k === 'c' ? 'c — 깊게 읽고 쓰고 설명' : k === 'b' ? `b — 자동 적용 후보 (상위 ${SHEET_B_MAX}, 제안은 주당 최대 ${MAX_AUTO}건)` : 'a — 인지만'}`);
    for (const r of rows) {
      const title = r.title.replace(/[\[\]]/g, '');
      const link = r.url ? `[${title}](${r.url})` : r.file ? `[[${r.file.replace(/\.md$/, '')}|${title}]]` : title;
      L.push(`- ${link} — ${r.reason}${r.minutes ? ` (약 ${r.minutes}분)` : ''}${r.project ? ` · ${r.project}` : ''}`);
    }
  }
  L.push('', '## 3. 개선 후보 (audit)', '', `- 스캔한 파일 ${aud.scannedFiles}개, 모델 ID ${Object.keys(aud.models).length}종, 도구 ${Object.keys(aud.tools).length}종`);
  if (!aud.suggestions.length) L.push('- 이번 주 제안 없음');
  for (const s of aud.suggestions) L.push(`- ${s.text}`);
  L.push('', '## 4. 승인 대기 제안', '');
  if (!descriptors.length) L.push('- 없음');
  for (const d of descriptors) {
    const id = proposalId(vault, d);
    L.push(`- \`${id}\` (${d.kind}) ${d.summary[0]}`, `  - 승인: \`attic approve ${id}\` · 거절: \`attic reject ${id}\``);
  }
  return L.join('\n') + '\n';
}

export async function review(ctx, { dryRun = false, week, now = new Date(), fresh = false } = {}) {
  const vault = requireVault(ctx);
  ensureSkeleton(vault);
  week = week || isoWeek(now);
  const expired = expireStale(vault, now);
  // Reuse this week's triage if it exists: the sheet must show what was classified, and a re-run
  // costs LLM calls and can come out slightly different. --fresh forces a new classification; a saved result with
  // runner errors, no items, or older than the current inbox/included notes is not reused.
  const saved = fresh ? null : readJson(atticPath(vault, 'triage', `${week}.json`), null);
  const tri = !triageIsStale(ctx, vault, saved) ? saved : await triage(ctx, { week, now });
  const aud = await audit(ctx, { now });
  const events = recentEvents(vault, 7, now);
  const descriptors = buildDescriptors(tri, aud);
  const sheet = renderSheet({ vault, week, tri, aud, events, descriptors, dryRun, nowIso: now.toISOString() });
  const sheetFile = writeAttic(vault, `reviews/${week}.md`, sheet);
  let proposals = [], notified = [];
  if (!dryRun) {
    proposals = descriptors.map((d) => createProposal(vault, { ...d, source: 'review' }, now).proposal);
    const pending = listProposals(vault, { status: 'pending' });
    if (pending.length) {
      const msg = {
        title: `brain-attic 주간 리뷰 ${week}`,
        text: `결정 대기 ${pending.length}건 (이번 주 새 제안 ${proposals.length}건). 시트: ${sheetFile}\n` +
          pending.slice(0, 5).map((p) => `- ${p.id} ${p.summary[0]}`).join('\n') + '\n승인: attic approve <id> / 거절: attic reject <id>',
      };
      notified = await dispatch(ctx, msg, pending);
    }
  }
  return { week, sheetFile, dryRun, expired: expired.length, counts: tri.counts, suggestions: aud.suggestions.length, proposals: proposals.map((p) => p.id), notified };
}
