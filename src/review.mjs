// attic review: triage + audit + radar -> approval sheet _attic/reviews/YYYY-Www.md, proposals, notifications.
import { requireVault } from './config.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { atticPath, ensureSkeleton, listRecentMd, writeAttic } from './vault.mjs';
import { isoWeek, readJson } from './util.mjs';
import { triage, renderRatioTable } from './triage.mjs';
import { audit } from './audit.mjs';
import { recentEvents } from './radar.mjs';
import { createProposal, expireStale, listProposals, proposalId } from './proposals.mjs';
import { apply } from './apply.mjs';
import { dispatch } from './notify/index.mjs';
import { savedDir } from './save.mjs';

const MAX_TEACH = 8;
/** b = "the system should apply this". Each one is a question to a human, so cap them per week. */
export const MAX_AUTO = 5;
export const MAX_DROP = 5;
export const SHEET_B_MAX = 15;

/** Where a triage item's text may later be read from: a vault note, a web link, or just its title. */
export function kindOfItem(i) {
  // An `attic save` note with a link holds only a memo: the page itself is what should be read later.
  if (i.source === 'saved' && /^https?:\/\//i.test(String(i.url || ''))) return 'url';
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
  const manual = savedDir(vault);
  for (const dir of [...(manual ? [manual] : []), ...(ctx.config.triage?.include || []).map((f) => (path.isAbsolute(f) ? f : path.join(vault, f)))]) {
    if (listRecentMd(dir, { sinceMs: since + 1 }).length) return true;
  }
  return false;
}

/** Radar event kinds that mean "a model (or a documented model endpoint) is new". */
export const NEW_MODEL_KINDS = ['new', 'modality', 'kie_new'];
export const SYSTEM_REVIEW_LIST = 10;

/**
 * New models this week -> ONE proposal per week: re-review the whole system (skills/scripts in audit.paths),
 * not only the files a capability match points at. Approval only writes a prompt file a human runs.
 */
export function systemReviewDescriptor(events, aud) {
  const fresh = (events || []).filter((e) => NEW_MODEL_KINDS.includes(e.kind));
  if (!fresh.length) return null;
  const ids = [...new Set(fresh.map((e) => e.id))];
  const names = ids.slice(0, SYSTEM_REVIEW_LIST);
  const inUse = Object.keys(aud?.models || {}).slice(0, 30);
  return {
    kind: 'system',
    summary: [
      `새 모델 ${ids.length}종이 나왔다 — 지금 쓰는 시스템 전체를 다시 검토할까요?`,
      `예: ${names.join(', ')}${ids.length > names.length ? ` 외 ${ids.length - names.length}종` : ''}`,
      inUse.length ? `지금 스킬·스크립트에서 쓰는 모델 ${Object.keys(aud.models).length}종 (audit.paths 기준)` : 'audit.paths 가 비어 있어 지금 쓰는 모델 목록은 없음 — config 에 스킬·스크립트 폴더를 넣으면 같이 대조합니다',
    ],
    payload: {
      op: 'system_review', newModels: names, modelsInUse: inUse, scannedFiles: aud?.scannedFiles || 0,
      prompt: '새 모델 목록과 지금 쓰는 모델 목록을 대조해, 작업별(텍스트·코드·이미지·영상·음성)로 지금 방식을 유지할지 바꿀지 표로 정리하세요. 바꾸자는 항목마다 이유(품질·가격·속도)와 시험 방법을 적고, 파일은 고치지 말고 제안만 하세요.',
    },
  };
}

/** used = proposals already created this ISO week per op, so the weekly caps hold across re-runs. */
export function buildDescriptors(tri, aud, used = {}, events = []) {
  const out = [];
  const sys = used.system_review ? null : systemReviewDescriptor(events, aud);
  if (sys) out.push(sys);
  const cs = tri.items.filter((i) => i.class === 'c').slice(0, Math.max(0, MAX_TEACH - (used.queue_teach || 0)));
  for (const c of cs) {
    out.push({
      kind: 'teach',
      summary: [`깊게 읽고 설명해 볼 것: ${c.title}`, `이유: ${c.reason}`, `예상 ${c.minutes}분${c.project ? ` · 프로젝트: ${c.project}` : ''}`],
      payload: { op: 'queue_teach', title: c.title, url: c.url, kind: kindOfItem(c), ...(c.file ? { file: c.file } : {}), project: c.project, minutes: c.minutes },
    });
  }
  for (const b of tri.items.filter((i) => i.class === 'b').slice(0, Math.max(0, MAX_AUTO - (used.note_auto || 0)))) {
    out.push({
      kind: 'auto',
      summary: [`자동 적용 후보 — 이 업데이트/변경을 시스템에 반영할까요? ${b.title}`, `이유: ${b.reason}`],
      // Not whitelisted on purpose: apply only writes _attic/approved/<id>.prompt.md for a human to run.
      payload: { op: 'note_auto', title: b.title, url: b.url, kind: kindOfItem(b), ...(b.file ? { file: b.file } : {}), project: b.project },
    });
  }
  // d: only vault notes can be tidied, and never by attic itself (it does not write outside _attic/).
  // Approval produces a prompt file a human runs (move to an archive folder, or delete).
  for (const d of tri.items.filter((i) => i.class === 'd' && i.file).slice(0, Math.max(0, MAX_DROP - (used.archive_note || 0)))) {
    out.push({
      kind: 'drop',
      summary: [`버릴 후보 — 이 노트를 보관함으로 옮길까요? ${d.title}`, `이유: ${d.reason}`],
      payload: { op: 'archive_note', title: d.title, file: d.file, kind: 'vault' },
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

export function renderSheet({ vault, week, tri, aud, events, descriptors, dryRun, nowIso, autoApplied = [] }) {
  const L = [`# 승인 시트 ${week}`, '', `생성: ${nowIso}${dryRun ? ' (dry-run: 제안 저장·발송 안 함)' : ''}`, ''];
  L.push('## 1. 이번 주 레이더', '');
  if (!events.length) L.push('- 변화 없음 (또는 아직 기준선만 저장됨)');
  for (const e of events.slice(0, 40)) L.push(`- [${e.source}] \`${e.id}\` — ${e.detail}`);
  L.push('', '## 2. 분류 결과', '',
    `- a ${tri.counts.a} / b ${tri.counts.b} / c ${tri.counts.c} / d ${tri.counts.d ?? 0} / 미분류 ${tri.counts.unclassified} — ${tri.weeklyMinutes != null ? `c 시간 ${tri.usedMinutes}/${tri.weeklyMinutes}분${tri.demoted ? ` (예산 초과로 a 강등 ${tri.demoted}건)` : ''}` : `c 예상 시간 합계 ${tri.usedMinutes}분 (예산 상한 없음)`}`);
  L.push(...renderRatioTable(tri.ratios));
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
    const cls = { queue_teach: 'c', note_auto: 'b', archive_note: 'd' }[d.payload?.op];
    L.push(`- \`${id}\` (${d.kind}) ${d.summary[0]}`, `  - 승인: \`attic approve ${id}\` · 거절: \`attic reject ${id}\`${cls ? ` · 분류 바꾸기: \`attic reclassify ${id} <a|b|c|d>\` · 답이 없으면 7일 뒤 추천(${cls}) 그대로 자동 적용` : ' · 답이 없으면 7일 뒤 만료'}`);
  }
  if (autoApplied.length) {
    L.push('', '## 5. 7일 무응답으로 추천 분류가 자동 적용된 제안 (auto-applied)', '');
    for (const p of autoApplied) L.push(`- \`${p.id}\` ${p.summary[0]}`);
  }
  return L.join('\n') + '\n';
}

export async function review(ctx, { dryRun = false, week, now = new Date(), fresh = false } = {}) {
  const vault = requireVault(ctx);
  ensureSkeleton(vault);
  week = week || isoWeek(now);
  const changed = expireStale(vault, now);
  const expired = changed.filter((p) => p.status === 'expired');
  const autoApproved = changed.filter((p) => p.status === 'approved');
  // Reuse this week's triage if it exists: the sheet must show what was classified, and a re-run
  // costs LLM calls and can come out slightly different. --fresh forces a new classification; a saved result with
  // runner errors, no items, or older than the current inbox/included notes is not reused.
  const saved = fresh ? null : readJson(atticPath(vault, 'triage', `${week}.json`), null);
  const tri = !triageIsStale(ctx, vault, saved) ? saved : await triage(ctx, { week, now });
  const aud = await audit(ctx, { now });
  const events = recentEvents(vault, 7, now);
  // Weekly caps count proposals already created this week (a re-run or --fresh must not add more).
  const used = {};
  for (const p of listProposals(vault)) {
    if (p.createdAt && isoWeek(new Date(p.createdAt)) === week && p.payload?.op) used[p.payload.op] = (used[p.payload.op] || 0) + 1;
  }
  const descriptors = buildDescriptors(tri, aud, used, events);
  // Classification suggestions nobody answered for 7 days are applied as recommended (not on --dry-run).
  const auto = dryRun ? { applied: [], prompts: [], errors: [] } : await apply(ctx, { now, onlyAuto: true });
  const autoApplied = autoApproved; // newly auto-approved in this run (apply() ran for them right above)
  const sheet = renderSheet({ vault, week, tri, aud, events, descriptors, dryRun, nowIso: now.toISOString(), autoApplied });
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
  return { week, sheetFile, dryRun, expired: expired.length, autoApplied: autoApplied.map((p) => p.id), counts: tri.counts, suggestions: aud.suggestions.length, proposals: proposals.map((p) => p.id), notified };
}
