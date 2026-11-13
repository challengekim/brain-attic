#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeCtx, requireVault } from '../src/config.mjs';
import { parseArgs } from '../src/util.mjs';

const HELP = {
  _: `attic — brain-attic CLI

사용법: attic <명령> [옵션]      (각 명령에 --help)

  init [--vault <path>] [--yes]       config·볼트 골격·템플릿·스킬 심링크 (멱등)
  doctor [--json]                     연동 상태와 "없으면 꺼지는 기능"
  collect                             출처(rss/atom/github releases) -> _attic/inbox
  save <URL> [메모] | --note "메모"     링크·메모 수동 저장 -> _attic/saved (triage 가 먼저 봄)
  radar [--json]                      OpenRouter·kie.ai 스냅샷 diff
  triage [--week YYYY-Www]            이번 주 항목을 a/b/c/d 로 분류
  audit                               스킬/스크립트의 모델·도구 목록화 + 개선 후보
  review [--dry-run] [--fresh] [--json] 승인 시트 + 제안 발송
  approve <id> | reject <id> | pending
  reclassify <id> <a|b|c|d>           분류 제안의 분류를 내가 정한다 (7일 무응답 자동 적용보다 우선)
  withdraw <id...> [--reason <글>]    대기 중인 제안을 철회한다 (중복·낡은 제안. 적용·자동 적용되지 않는다)
  discard <id...> [--reason <글>]     철회·만료·거절된 제안을 폐기한다 (같은 노트·링크를 다시 제안하지 않는다)
  archive [--run [--limit N]] | archive undo <id...>|--all | archive log   승인한 보관(d) 노트를 90_Archive/ 로 옮긴다 (기본은 계획만)
  sync                                양방향 어댑터에서 답을 가져오고 자기 것만 ack
  apply                               승인된 제안 적용 (화이트리스트 연산만 직접, 해 볼 것은 할일로)
  tick                                재발송 + sync + apply 한 번 (예약: 매시 20분 — 못 보낸 카드 재발송, 앱에서 누른 승인을 1시간 안에 반영)
  todo [status] | todo resolve <id> --delivered|--retry   결과를 알 수 없는 할일 배달 확인
  retro [--month YYYY-MM] [--dry-run] 월간 자기평가
  feedback [--prompt] [--json] | feedback tag <id> <태그> [--note <글>]   내 답 원장·추천 일치율·분류기가 받는 지침
  schedule install|uninstall|status [--dry-run]
  teach <주제|파일|URL> [--quiz-first] [--next|--queue|--due|--review <slug>|--save-session <json>]   설명 → 퀴즈 → 내가 설명하기
`,
  init: '사용법: attic init [--vault <path>] [--yes]\n  config($XDG_CONFIG_HOME/brain-attic/config.json)와 볼트 _attic/ 골격을 만들고, 스킬을 ~/.claude/skills, ~/.codex/skills 에 심링크합니다. 있는 것은 덮지 않습니다.',
  doctor: '사용법: attic doctor [--json]\n  git/gh/claude/codex/aws/railway/gws/aside/playwright/Chrome/볼트/obsidian 유무와 용도.',
  collect: '사용법: attic collect\n  config.sources 를 받아 _attic/inbox/YYYY-MM-DD.md 에 추가합니다 (URL 정규화 + 60일 중복 원장).',
  save: '사용법: attic save <URL> [메모...] [--note "메모"] [--title "제목"]\n  링크나 메모를 _attic/saved/YYYY-MM-DD-<slug>.md 로 저장합니다. 네트워크를 쓰지 않습니다. 이번 주 triage 가 수집 항목보다 먼저 분류합니다.',
  radar: '사용법: attic radar [--json]\n  첫 실행은 기준선 저장, 이후는 신규 모델·가격 ±20%·새 출력 모달리티·kie.ai 새 문서를 보고합니다.',
  triage: '사용법: attic triage [--week YYYY-Www]\n  a=인지만 b=자동 적용 c=깊게(예상 분 포함) d=버릴 것. 기본은 상한 없이 전부 분류하고 실제 비율 vs 기대 비율(triage.targetRatios)은 보고서에 보이기만 한다. config 에 maxItems / weeklyMinutes 를 적었으면 그 상한을 지킨다. 여러 프로젝트에서 쓰이거나 자주 링크된 지식은 c 후보. LLM 실패 시 미분류.',
  audit: '사용법: attic audit [--json]\n  config.audit.paths 의 모델 ID/도구를 목록화하고 radar 사건과 대조해 개선 후보를 냅니다 (모델명 단순 치환 제안은 없음).',
  review: '사용법: attic review [--dry-run] [--fresh] [--json]\n  triage + audit + radar -> _attic/reviews/YYYY-Www.md, 제안 저장·발송. 이번 주 분류가 있으면 재사용(--fresh 로 다시 분류). --dry-run 은 시트만.',
  withdraw: '사용법: attic withdraw <id...> [--reason <글>]\n  대기 중(pending)인 제안만 철회합니다. 철회한 제안은 적용되지 않고, 7일이 지나도 자동 적용되지 않으며, 회고의 승인율에도 들어가지 않습니다.\n  이미 앱(decision-api)에 보낸 카드는 남지만, 거기서 눌러도 로컬에서는 아무것도 바뀌지 않습니다(ack 만 합니다).',
  discard: '사용법: attic discard <id...> [--reason <글>]\n  철회(withdrawn)·만료(expired)·거절(rejected)된 제안을 «폐기» 로 닫습니다. 그 노트·링크는 다음 주부터 어떤 문구로도 다시 카드가 되지 않고, 같은 제안이 되살아나지도 않습니다.',
  archive: '사용법: attic archive [--json] | attic archive --run [--limit N] | attic archive undo <id...> | attic archive undo --all | attic archive log\n  승인한 보관(d) 카드의 노트를 볼트 안 90_Archive/<원래 경로> 로 옮깁니다. 기본은 계획만 보여 줍니다(원 경로 → 새 경로, 없음·충돌·링크 때문에 보류, 공개 재료 허용 목록에서 빠지는지).\n  --run: 실제로 옮깁니다. 덮어쓰지 않고(하드 링크 후 원래 자리 제거) 앞뒤 해시를 비교하며, 모든 이동을 _attic/archive/ledger.json 에 남깁니다. 다른 노트에 적힌 이 노트의 볼트 전체 경로([[10_Knowledge/…/노트|별칭]], 글자로 적은 10_Knowledge/…/노트.md)는 새 경로로 바꾸고 원장에 남깁니다(undo 가 되돌림). 그 밖의 경로 링크(일부 경로·대소문자 다름)·마크다운 링크로 가리키는 노트, [[이름]] 링크가 있는데 같은 이름의 노트가 또 있는 노트는 옮기지 않습니다. attic apply(매시 tick)도 승인된 보관 카드를 같은 방식으로 옮깁니다.\n  undo: 원장을 보고 제자리로 되돌리고 바꾼 경로도 되돌립니다(보관본이 바뀌었거나 원래 자리에 다른 파일이 있으면 거부). 볼트 노트는 지우지 않습니다.',
  reclassify: '사용법: attic reclassify <id> <a|b|c|d>\n  대기 중인 분류 제안(c 설명하기 / b 자동 적용 / d 보관)의 분류를 바꿉니다. a 는 «인지만» 이라 제안을 닫습니다. 분류 제안은 7일 동안 답이 없으면 추천 분류 그대로 자동 적용됩니다.',
  approve: '사용법: attic approve <id>', reject: '사용법: attic reject <id>', pending: '사용법: attic pending [--json]',
  sync: '사용법: attic sync\n  decision-api / github-issues 에서 답을 가져옵니다. 로컬에 있는 제안 id 만 ack 합니다.',
  apply: '사용법: attic apply\n  approved 제안만. add_source/remove_source/set_triage_budget/queue_teach/add_triage_rule 은 직접, archive_note(보관)는 노트를 90_Archive/ 로 옮기고(attic archive 참고), try_in_project(해 볼 것)는 지시문을 쓰고 config.todo 가 있으면 할일을 하나 만듭니다, 나머지는 _attic/approved/<id>.prompt.md 만 만듭니다.',
  tick: '사용법: attic tick\n  알림 때 못 보낸 대기 제안을 양방향 어댑터로 다시 보내고, 양방향 어댑터에서 답을 가져오고(sync) 승인된 제안을 적용(apply)합니다. 만료는 하지 않습니다(월요일 review 몫). 예약이 매시 20분에 돌립니다.',
  todo: '사용법: attic todo [status] | attic todo resolve <id> --delivered|--retry\n  할일 명령이 시간 초과·알 수 없는 종료로 끝났거나 도중에 멈춘 «해 볼 것» 을 보여줍니다. 앱에서 attic:<id> 를 찾아보고,\n  있으면 --delivered(닫기), 없으면 --retry(다음 apply 가 다시 만든다).',
  retro: '사용법: attic retro [--month YYYY-MM] [--dry-run]\n  기본은 지난달.',
  feedback: '사용법: attic feedback [--prompt] [--json] | attic feedback tag <id> <태그> [--note <글>]\n  내가 답한 카드(승인·거절·분류 바꿈)로 원장(_attic/feedback/ledger.json)을 다시 만들고 주별 추천 일치율과 승인된 분류 규칙을 보여줍니다.\n  --prompt: 다음 분류 때 모델이 받는 지침(승인한 규칙 + 최근 답 + 내 시스템 요약)을 그대로 출력합니다(모델 호출 없음).\n  tag: 추천과 다르게 답한 이유를 남깁니다. 태그: already-in-system, already-implemented, not-applicable, digest-wrapper, sleeping-project, not-worth-time, noise, worth-more, other',
  schedule: '사용법: attic schedule install|uninstall|status [--dry-run]\n  macOS: LaunchAgents, Linux: crontab 블록. collect 매일 08:00, radar 매일 09:10, review 월 08:30, retro 매월 1일 09:00, tick 매시 20분.',
  teach: '사용법: attic teach --help',
};

const printJson = (o) => console.log(JSON.stringify(o, null, 2));

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(HELP._); return 0; }
  if (cmd === '--version' || cmd === '-v') {
    console.log(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version); return 0;
  }
  if (!(cmd in HELP)) { console.error(`알 수 없는 명령: ${cmd}\n`); console.error(HELP._); return 2; }
  // teach has its own detailed help in src/teach.mjs
  if (cmd !== 'teach' && (rest.includes('--help') || rest.includes('-h'))) { console.log(HELP[cmd]); return 0; }
  const args = parseArgs(rest, { string: ['vault', 'week', 'month', 'note', 'title', 'reason', 'limit'], bool: ['json', 'yes', 'dry-run', 'fresh', 'delivered', 'retry', 'run', 'all'] });
  const ctx = makeCtx({ vaultOverride: args.vault && cmd !== 'init' ? args.vault : undefined });

  switch (cmd) {
    case 'init': {
      const { init } = await import('../src/init.mjs');
      const r = await init(ctx, { vault: args.vault, yes: !!args.yes });
      console.log(`볼트: ${r.vault}\n${r.notes.map((n) => `  - ${n}`).join('\n')}\n다음: attic doctor, attic radar`);
      return 0;
    }
    case 'doctor': {
      const { doctor, renderDoctor } = await import('../src/doctor.mjs');
      const r = await doctor(ctx);
      if (args.json) printJson(r); else console.log(renderDoctor(r));
      return r.ok ? 0 : 1;
    }
    case 'collect': {
      const { collect } = await import('../src/collect.mjs');
      const r = await collect(ctx);
      console.log(`수집 ${r.added}건 추가, 중복 ${r.duplicates}건 제외, 상한·기간 밖 ${r.skipped || 0}건 건너뜀, 오류 ${r.errors.length}건`);
      return 0;
    }
    case 'save': {
      const { save, parseSaveArgs } = await import('../src/save.mjs');
      const r = save(ctx, parseSaveArgs(args._, { note: args.note, title: args.title }));
      console.log(`저장: ${r.file}`);
      return 0;
    }
    case 'radar': {
      const { radar, changeCount } = await import('../src/radar.mjs');
      const r = await radar(ctx);
      if (args.json) { printJson(r); return 0; }
      for (const s of r.results) {
        const msg = s.status === 'baseline' ? `기준선 저장 (${s.count}개)` : s.status === 'skipped' ? `건너뜀 (${s.error})` : `변화 ${changeCount(s)}건`;
        console.log(`${s.name}: ${msg}`);
      }
      console.log(`보고서: ${r.file}`);
      return 0;
    }
    case 'triage': {
      const { triage, renderTriage } = await import('../src/triage.mjs');
      const t = await triage(ctx, { week: args.week });
      console.log(renderTriage(t));
      return 0;
    }
    case 'audit': {
      const { audit } = await import('../src/audit.mjs');
      const r = await audit(ctx);
      if (args.json) printJson(r);
      else { console.log(`파일 ${r.scannedFiles}개, 모델 ID ${Object.keys(r.models).length}종, 도구 ${Object.keys(r.tools).length}종, 개선 후보 ${r.suggestions.length}건`); for (const s of r.suggestions) console.log(`- ${s.text}`); }
      return 0;
    }
    case 'review': {
      const { review } = await import('../src/review.mjs');
      const { withRunLock } = await import('../src/runlock.mjs');
      const runReview = () => review(ctx, { dryRun: !!args['dry-run'], week: args.week, fresh: !!args.fresh });
      const r = args['dry-run'] ? await runReview() : await withRunLock(requireVault(ctx), runReview);
      if (args.json) printJson(r);
      else console.log(`시트: ${r.sheetFile}\n분류: a ${r.counts.a} / b ${r.counts.b} / c ${r.counts.c} / d ${r.counts.d ?? 0} / 미분류 ${r.counts.unclassified}\n제안 ${r.proposals.length}건${r.dryRun ? ' (dry-run: 저장·발송 안 함)' : ''}`);
      return 0;
    }
    case 'approve': case 'reject': {
      const { decide } = await import('../src/proposals.mjs');
      const id = args._[0];
      if (!id) { console.error(HELP[cmd]); return 2; }
      const want = cmd === 'approve' ? 'approved' : 'rejected';
      const r = decide(requireVault(ctx), id, want, { by: 'cli' });
      if (r.reason === 'auto-applied') { console.log(`${r.proposal.id}: TTL 이 지났지만 분류 제안이라 추천대로 자동 적용(approved, auto-applied)했습니다 — attic apply 로 반영`); return 0; }
      if (r.reason === 'expired') { console.error(`${id}: 만료돼서 ${want} 하지 않았습니다 (TTL 7일) -> expired`); return 1; }
      if (r.reason === 'not-pending' && !r.ok) { console.error(`${id}: 이미 ${r.proposal.status} 상태라 바꾸지 않았습니다`); return 1; }
      console.log(`${r.proposal.id}: ${r.proposal.status}`);
      return 0;
    }
    case 'reclassify': {
      const { reclassify } = await import('../src/proposals.mjs');
      const [id, cls] = args._;
      if (!id || !cls) { console.error(HELP.reclassify); return 2; }
      try { const p = reclassify(requireVault(ctx), id, String(cls).toLowerCase(), { by: 'cli' }); console.log(`${p.id}: 분류 ${p.userClass}${p.status === 'pending' ? ' (대기 중, 승인하거나 7일 뒤 자동 적용)' : ` (${p.status})`}`); return 0; }
      catch (e) { console.error(e.message); return 1; }
    }
    case 'withdraw': {
      const { withdraw } = await import('../src/proposals.mjs');
      const ids = args._;
      if (!ids.length) { console.error(HELP.withdraw); return 2; }
      const vault = requireVault(ctx);
      let rc = 0;
      for (const id of ids) {
        try { const p = withdraw(vault, id, { by: 'cli', reason: args.reason || '' }); console.log(`${p.id}: withdrawn`); }
        catch (e) { console.error(e.message); rc = 1; }
      }
      return rc;
    }
    case 'discard': {
      const { discard } = await import('../src/proposals.mjs');
      const ids = args._;
      if (!ids.length) { console.error(HELP.discard); return 2; }
      const vault = requireVault(ctx);
      let rc = 0;
      for (const id of ids) {
        try { const p = discard(vault, id, { by: 'cli', reason: args.reason || '' }); console.log(`${p.id}: 폐기 (${p.status})`); }
        catch (e) { console.error(e.message); rc = 1; }
      }
      return rc;
    }
    case 'archive': {
      const ar = await import('../src/archive.mjs');
      const { withRunLock } = await import('../src/runlock.mjs');
      const vault = requireVault(ctx);
      if (args._[0] === 'log') {
        const led = ar.readArchiveLedger(vault);
        if (args.json) printJson(led);
        else if (!led.length) console.log('옮긴 기록이 없습니다');
        else for (const e of led) console.log(`${(e.movedAt || e.startedAt || '').slice(0, 16)}  ${e.status}  ${e.proposalId}  ${e.from} -> ${e.to}${e.undoneAt ? `  (되돌림 ${e.undoneAt.slice(0, 16)})` : ''}${e.error ? `  ! ${e.error}` : ''}`);
        return 0;
      }
      if (args._[0] === 'undo') {
        const ids = args.all ? 'all' : args._.slice(1);
        if (ids !== 'all' && !ids.length) { console.error(HELP.archive); return 2; }
        const r = await withRunLock(vault, () => ar.undoArchive(vault, ids));
        console.log(`되돌림 ${r.restored.length}건, 거부 ${r.refused.length}건`);
        for (const e of r.restored) console.log(`  + ${e.proposalId}  ${e.to} -> ${e.from}`);
        for (const e of r.refused) console.log(`  ! ${e.proposalId}  ${e.reason}`);
        return r.refused.length ? 1 : 0;
      }
      if (args._.length) { console.error(HELP.archive); return 2; }
      const limit = args.limit === undefined ? Infinity : Number(args.limit);
      if (!(limit === Infinity || (Number.isInteger(limit) && limit > 0))) { console.error('--limit 은 1 이상 정수여야 합니다'); return 2; }
      const run = () => ar.runArchive(ctx, { dryRun: !args.run, limit });
      const r = args.run ? await withRunLock(vault, run) : await run();
      if (args.json) { printJson(r); return 0; }
      console.log(ar.renderPlan(r.plan));
      if (!args.run) { console.log('\n(계획만 — 옮기려면 attic archive --run [--limit N])'); return 0; }
      console.log(`\n옮김 ${r.moved.length}건 · 이미 보관됨으로 닫음 ${r.already.length}건 · 건너뜀 ${r.skipped.length}건 · 오류 ${r.errors.length}건`);
      for (const e of r.errors) console.log(`  ! ${e.id}: ${e.error}`);
      return r.errors.length ? 1 : 0;
    }
    case 'pending': {
      const { listProposals, expireStale } = await import('../src/proposals.mjs');
      const vault = requireVault(ctx);
      expireStale(vault);
      const list = listProposals(vault, { status: 'pending' });
      if (args.json) printJson(list);
      else if (!list.length) console.log('대기 중인 제안이 없습니다');
      else for (const p of list) console.log(`${p.id}  (~${p.expiresAt.slice(0, 10)})  ${p.summary[0]}`);
      return 0;
    }
    case 'sync': {
      const { syncAll } = await import('../src/notify/index.mjs');
      const { expireStale } = await import('../src/proposals.mjs');
      const { withRunLock } = await import('../src/runlock.mjs');
      const res = await withRunLock(requireVault(ctx), () => syncAll(ctx));
      // A failed pull may hide an on-time answer: expire only after every adapter answered.
      if (res.every((r) => r.ok !== false)) expireStale(ctx.vault);
      if (!res.length) console.log('양방향 어댑터(decision-api, github-issues)가 설정돼 있지 않습니다');
      for (const r of res) console.log(`${r.type}: ${r.ok ? `변경 ${r.changed?.length ?? 0}건${r.acked ? `, ack ${r.acked.length}건, 무시 ${r.ignored.length}건` : ''}` : `실패 (${r.error})`}`);
      return 0;
    }
    case 'apply': {
      const { apply } = await import('../src/apply.mjs');
      const { withRunLock } = await import('../src/runlock.mjs');
      const r = await withRunLock(requireVault(ctx), () => apply(ctx));
      console.log(`적용 ${r.applied.length}건, 프롬프트 파일 ${r.prompts.length}건, 오류 ${r.errors.length}건`);
      for (const p of r.prompts) console.log(`  - ${p.file}`);
      for (const e of r.errors) console.log(`  ! ${e.id}: ${e.error}`);
      return r.errors.length ? 1 : 0;
    }
    case 'tick': {
      const { syncAll, resendUnsent } = await import('../src/notify/index.mjs');
      const { apply } = await import('../src/apply.mjs');
      const { tryRunLock } = await import('../src/runlock.mjs');
      // Another run (review, retro, ...) is changing proposals: skip this hour instead of racing it; the next tick catches up.
      const release = tryRunLock(requireVault(ctx));
      if (!release) { console.log(JSON.stringify({ at: new Date().toISOString(), locked: true, note: '다른 실행이 잠금을 쥐고 있어 이번 시간은 건너뜀' })); return 0; }
      let resent, res, r;
      try { resent = await resendUnsent(ctx); res = await syncAll(ctx); r = await apply(ctx); } finally { release(); }
      console.log(JSON.stringify({ at: new Date().toISOString(), sync: res.map((x) => ({ type: x.type, ok: x.ok !== false, changed: x.changed?.length ?? 0, ...(x.error ? { error: x.error } : {}) })),
        applied: r.applied.map((x) => x.id), prompts: r.prompts.map((x) => x.id), skipped: r.skipped.length, errors: r.errors,
        resent: resent.map((x) => ({ type: x.type, ok: x.ok !== false, sent: x.sent ?? 0, ...(x.error ? { error: x.error } : {}) })) }));
      return 0;
    }
    case 'todo': {
      const { todoStatus, resolveTodo } = await import('../src/todo.mjs');
      const vault = requireVault(ctx);
      const [sub = 'status', id] = args._;
      if (sub === 'status') {
        const list = todoStatus(vault);
        if (args.json) printJson(list);
        else if (!list.length) console.log('확인이 필요한 할일 배달이 없습니다');
        else for (const t of list) console.log(`${t.id}  ${t.state}  ${t.project}: ${t.title}${t.error ? `\n    ${t.error}` : ''}`);
        return 0;
      }
      if (sub === 'resolve' && id && (args.delivered || args.retry)) {
        try { const p = resolveTodo(vault, id, args.delivered ? 'delivered' : 'retry'); console.log(`${p.id}: ${args.delivered ? '배달됨으로 닫았습니다' : '다음 apply 가 다시 만듭니다'}`); return 0; }
        catch (e) { console.error(e.message); return 1; }
      }
      console.error(HELP.todo); return 2;
    }
    case 'retro': {
      const { retro } = await import('../src/retro.mjs');
      const { withRunLock } = await import('../src/runlock.mjs');
      const runRetro = () => retro(ctx, { month: args.month, dryRun: !!args['dry-run'] });
      const r = args['dry-run'] ? await runRetro() : await withRunLock(requireVault(ctx), runRetro);
      console.log(`회고: ${r.file}\n제안 ${r.proposals.length}건`);
      return 0;
    }
    case 'feedback': {
      const fb = await import('../src/feedback.mjs');
      const vault = requireVault(ctx);
      if (args._[0] === 'tag') {
        const [, id, tag] = args._;
        if (!id || !tag) { console.error(HELP.feedback); return 2; }
        try { fb.recordReason(vault, id, tag, args.note || ''); console.log(`${id}: 이유 ${tag}${args.note ? ` — ${args.note}` : ''}`); return 0; }
        catch (e) { console.error(e.message); return 1; }
      }
      if (args.prompt) { const g = fb.guideFor(ctx); console.log(g.text || '(지침 없음 — 승인한 규칙·답한 카드·triage.context 가 아직 없습니다)'); console.error(`\n[지침] 규칙 ${g.rules}개 · 답 사례 ${g.examples}건 · 시스템 요약 ${g.contextChars}자 · key ${g.key}`); return 0; }
      const ledger = fb.buildLedger(vault);
      const metrics = fb.weeklyMetrics(ledger.entries, vault);
      if (args.json) { printJson({ entries: ledger.entries, metrics, rules: fb.readRules(vault) }); return 0; }
      console.log(`원장: 답한 카드 ${ledger.entries.length}건 (추천과 다름 ${ledger.entries.filter((e) => !e.agreed).length}건, 이유 기록 ${ledger.entries.filter((e) => e.reasonTag).length}건)\n`);
      console.log(fb.renderMetrics(metrics).join('\n'));
      const rules = fb.readRules(vault);
      console.log(`\n승인된 분류 규칙 ${rules.length}개${rules.length ? '\n' + rules.map((r) => `- ${r.text}`).join('\n') : ''}`);
      return 0;
    }
    case 'schedule': {
      const { schedule, renderScheduleResult } = await import('../src/schedule.mjs');
      const action = args._[0];
      if (!['install', 'uninstall', 'status'].includes(action)) { console.error(HELP.schedule); return 2; }
      const r = await schedule(ctx, action, { dryRun: !!args['dry-run'] });
      console.log(renderScheduleResult(r));
      return 0;
    }
    case 'teach': {
      const target = new URL('../src/teach.mjs', import.meta.url);
      if (!fs.existsSync(fileURLToPath(target))) { console.error('teach 모듈 없음: src/teach.mjs 가 아직 설치되지 않았습니다'); return 1; }
      const mod = await import('../src/teach.mjs');
      const llm = await import('../src/llm.mjs');
      const vaultUtil = await import('../src/vault.mjs');
      const code = await mod.teach(rest, { ...ctx, llm, vaultUtil });
      return typeof code === 'number' ? code : 0;
    }
  }
  return 0;
}

main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(`오류: ${e.message}`); process.exitCode = 1; });
