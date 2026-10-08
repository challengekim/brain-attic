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
  radar [--json]                      OpenRouter·kie.ai 스냅샷 diff
  triage [--week YYYY-Www]            이번 주 항목을 a/b/c 로 분류
  audit                               스킬/스크립트의 모델·도구 목록화 + 개선 후보
  review [--dry-run] [--json]         승인 시트 + 제안 발송
  approve <id> | reject <id> | pending
  sync                                양방향 어댑터에서 답을 가져오고 자기 것만 ack
  apply                               승인된 제안 적용 (화이트리스트 연산만 직접)
  retro [--month YYYY-MM] [--dry-run] 월간 자기평가
  schedule install|uninstall|status [--dry-run]
  teach <주제|파일|URL> [--next|--queue|--due|--review <slug>]   설명 → 퀴즈 → 내가 설명하기
`,
  init: '사용법: attic init [--vault <path>] [--yes]\n  config($XDG_CONFIG_HOME/brain-attic/config.json)와 볼트 _attic/ 골격을 만들고, 스킬을 ~/.claude/skills, ~/.codex/skills 에 심링크합니다. 있는 것은 덮지 않습니다.',
  doctor: '사용법: attic doctor [--json]\n  git/gh/claude/codex/aws/railway/gws/aside/playwright/Chrome/볼트/obsidian 유무와 용도.',
  collect: '사용법: attic collect\n  config.sources 를 받아 _attic/inbox/YYYY-MM-DD.md 에 추가합니다 (URL 정규화 + 60일 중복 원장).',
  radar: '사용법: attic radar [--json]\n  첫 실행은 기준선 저장, 이후는 신규 모델·가격 ±20%·새 출력 모달리티·kie.ai 새 문서를 보고합니다.',
  triage: '사용법: attic triage [--week YYYY-Www]\n  a=인지만 b=자동 적용 c=깊게(예상 분 포함). 주간 예산 초과분 c 는 a 로 강등. LLM 실패 시 미분류.',
  audit: '사용법: attic audit [--json]\n  config.audit.paths 의 모델 ID/도구를 목록화하고 radar 사건과 대조해 개선 후보를 냅니다 (모델명 단순 치환 제안은 없음).',
  review: '사용법: attic review [--dry-run] [--fresh] [--json]\n  triage + audit + radar -> _attic/reviews/YYYY-Www.md, 제안 저장·발송. 이번 주 분류가 있으면 재사용(--fresh 로 다시 분류). --dry-run 은 시트만.',
  approve: '사용법: attic approve <id>', reject: '사용법: attic reject <id>', pending: '사용법: attic pending [--json]',
  sync: '사용법: attic sync\n  decision-api / github-issues 에서 답을 가져옵니다. 로컬에 있는 제안 id 만 ack 합니다.',
  apply: '사용법: attic apply\n  approved 제안만. add_source/remove_source/set_triage_budget/queue_teach 는 직접, 나머지는 _attic/approved/<id>.prompt.md 만 만듭니다.',
  retro: '사용법: attic retro [--month YYYY-MM] [--dry-run]\n  기본은 지난달.',
  schedule: '사용법: attic schedule install|uninstall|status [--dry-run]\n  macOS: LaunchAgents, Linux: crontab 블록. radar 매일 09:10, review 월 08:30, retro 매월 1일 09:00.',
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
  const args = parseArgs(rest, { string: ['vault', 'week', 'month'], bool: ['json', 'yes', 'dry-run', 'fresh'] });
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
      const r = await review(ctx, { dryRun: !!args['dry-run'], week: args.week, fresh: !!args.fresh });
      if (args.json) printJson(r);
      else console.log(`시트: ${r.sheetFile}\n분류: a ${r.counts.a} / b ${r.counts.b} / c ${r.counts.c} / 미분류 ${r.counts.unclassified}\n제안 ${r.proposals.length}건${r.dryRun ? ' (dry-run: 저장·발송 안 함)' : ''}`);
      return 0;
    }
    case 'approve': case 'reject': {
      const { decide } = await import('../src/proposals.mjs');
      const id = args._[0];
      if (!id) { console.error(HELP[cmd]); return 2; }
      const want = cmd === 'approve' ? 'approved' : 'rejected';
      const r = decide(requireVault(ctx), id, want, { by: 'cli' });
      if (r.reason === 'expired') { console.error(`${id}: 만료돼서 ${want} 하지 않았습니다 (TTL 7일) -> expired`); return 1; }
      if (r.reason === 'not-pending' && !r.ok) { console.error(`${id}: 이미 ${r.proposal.status} 상태라 바꾸지 않았습니다`); return 1; }
      console.log(`${r.proposal.id}: ${r.proposal.status}`);
      return 0;
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
      requireVault(ctx);
      const res = await syncAll(ctx);
      expireStale(ctx.vault);
      if (!res.length) console.log('양방향 어댑터(decision-api, github-issues)가 설정돼 있지 않습니다');
      for (const r of res) console.log(`${r.type}: ${r.ok ? `변경 ${r.changed?.length ?? 0}건${r.acked ? `, ack ${r.acked.length}건, 무시 ${r.ignored.length}건` : ''}` : `실패 (${r.error})`}`);
      return 0;
    }
    case 'apply': {
      const { apply } = await import('../src/apply.mjs');
      const r = await apply(ctx);
      console.log(`적용 ${r.applied.length}건, 프롬프트 파일 ${r.prompts.length}건, 오류 ${r.errors.length}건`);
      for (const p of r.prompts) console.log(`  - ${p.file}`);
      for (const e of r.errors) console.log(`  ! ${e.id}: ${e.error}`);
      return r.errors.length ? 1 : 0;
    }
    case 'retro': {
      const { retro } = await import('../src/retro.mjs');
      const r = await retro(ctx, { month: args.month, dryRun: !!args['dry-run'] });
      console.log(`회고: ${r.file}\n제안 ${r.proposals.length}건`);
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
