// attic review: triage + audit + radar -> approval sheet _attic/reviews/YYYY-Www.md, proposals, notifications.
import { requireVault } from './config.mjs';
import { atticPath, ensureSkeleton, writeAttic } from './vault.mjs';
import { isoWeek, readJson } from './util.mjs';
import { triage } from './triage.mjs';
import { audit } from './audit.mjs';
import { recentEvents } from './radar.mjs';
import { createProposal, expireStale, listProposals, proposalId } from './proposals.mjs';
import { dispatch } from './notify/index.mjs';

const MAX_TEACH = 8;

export function buildDescriptors(tri, aud) {
  const out = [];
  const cs = tri.items.filter((i) => i.class === 'c').slice(0, MAX_TEACH);
  for (const c of cs) {
    out.push({
      kind: 'teach',
      summary: [`깊게 읽고 설명해 볼 것: ${c.title}`, `이유: ${c.reason}`, `예상 ${c.minutes}분${c.project ? ` · 프로젝트: ${c.project}` : ''}`],
      payload: { op: 'queue_teach', title: c.title, url: c.url, project: c.project, minutes: c.minutes },
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
  for (const k of ['c', 'a']) {
    const rows = tri.items.filter((i) => i.class === k).slice(0, k === 'a' ? 15 : 30);
    if (!rows.length) continue;
    L.push('', `### ${k === 'c' ? 'c — 깊게 읽고 쓰고 설명' : 'a — 인지만'}`);
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
  // costs LLM calls and can come out slightly different. --fresh forces a new classification.
  const saved = fresh ? null : readJson(atticPath(vault, 'triage', `${week}.json`), null);
  const tri = saved && Array.isArray(saved.items) ? saved : await triage(ctx, { week, now });
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
