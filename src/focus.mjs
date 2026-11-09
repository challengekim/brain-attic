// Project focus (2026-11-09): the owner's dated plan of which project to push and which to put to sleep, in
// config.triage.projectFocus, e.g.
//   [{ "project": "rivalhook", "state": "focus", "from": "2026-11-16", "to": "2026-11-22", "note": "집중 주간" },
//    { "project": "onemove",   "state": "sleep", "to": "2026-11-22", "note": "일단 미룸" }]
// from/to are inclusive local dates (either may be left out). An entry counts only inside its window, so a plan
// switches itself off when the dates pass -- nothing is hard-coded. Used twice: the classifier is told the states
// (feedback.guideFor), and after it answers the code holds back try cards on a sleeping project (applyFocus).
import { dateStr } from './util.mjs';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const FOCUS_STATES = ['focus', 'sleep'];

/** Valid entries only (a bad one is dropped, never guessed at). */
export function focusEntries(config) {
  const raw = config?.triage?.projectFocus;
  if (!Array.isArray(raw)) return [];
  return raw.filter((e) => e && typeof e === 'object' && typeof e.project === 'string' && e.project.trim()
    && FOCUS_STATES.includes(e.state)
    && (e.from === undefined || DAY.test(e.from)) && (e.to === undefined || DAY.test(e.to))
    && !(e.from && e.to && e.from > e.to))
    .map((e) => ({ project: e.project.trim(), state: e.state, ...(e.from ? { from: e.from } : {}), ...(e.to ? { to: e.to } : {}), ...(typeof e.note === 'string' && e.note.trim() ? { note: e.note.trim().slice(0, 200) } : {}) }));
}

/** Entries in force on `now`'s local date. A project both focused and asleep that day counts as focused. */
export function activeFocus(config, now = new Date()) {
  const today = dateStr(now);
  const on = focusEntries(config).filter((e) => (!e.from || e.from <= today) && (!e.to || today <= e.to));
  const focused = new Set(on.filter((e) => e.state === 'focus').map((e) => e.project.toLowerCase()));
  return on.filter((e) => e.state === 'focus' || !focused.has(e.project.toLowerCase()));
}

const span = (e) => `${e.from || ''}~${e.to || ''}`;

/** Lines for the classifier (no date of today in them, so the text -- and the triage key -- changes only at a boundary). */
export function focusLines(active) {
  if (!active.length) return [];
  return ['프로젝트 상태 (태우님이 정한 기간 — 기간이 지나면 저절로 풀린다. 프로젝트를 재우는지·밀어주는지는 이것만 따른다):',
    ...active.map((e) => e.state === 'focus'
      ? `- ${e.project}: 집중 (${span(e)}) — 이 프로젝트에 붙는 try 를 먼저 찾는다. 막힌 곳을 직접 푸는 것은 priority 1~2 를 준다.${e.note ? ` 메모: ${e.note}` : ''}`
      : `- ${e.project}: 재움 (${span(e)}) — try 를 붙이지 않는다. 이 프로젝트만을 위한 공부(learn)도 미루고 a 로 둔다.${e.note ? ` 메모: ${e.note}` : ''}`)];
}

/**
 * After classification: a try on a sleeping project becomes a (the prompt asks for this; the code makes sure), and a
 * try on a focused project is marked focus (ranked first for the weekly try slots). Mutates items; returns counts.
 */
export function applyFocus(items, active) {
  const sleep = new Map(active.filter((e) => e.state === 'sleep').map((e) => [e.project.toLowerCase(), e]));
  const focus = new Set(active.filter((e) => e.state === 'focus').map((e) => e.project.toLowerCase()));
  let slept = 0, focused = 0;
  for (const it of items) {
    if (it.class !== 'c' || it.action !== 'try' || !it.project) continue;
    const key = it.project.toLowerCase();
    const s = sleep.get(key);
    if (s) {
      it.sleptFrom = 'c(try)';
      for (const k of ['minutes', 'action', 'pain', 'next', 'check', 'priority']) delete it[k];
      it.class = 'a';
      it.reason = `${it.reason} (재움: ${it.project} ${span(s)} — 해 볼 것은 기간이 끝난 뒤)`;
      slept++;
    } else if (focus.has(key)) { it.focus = true; focused++; }
  }
  return { slept, focused };
}
