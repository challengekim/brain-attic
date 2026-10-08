// One-way notifiers: stdout, macos, discord, slack, telegram, email, ntfy.
// Config holds ENV VAR NAMES only (e.g. {"type":"discord","webhookEnv":"ATTIC_DISCORD_WEBHOOK"}).
import { run, which } from '../util.mjs';
import { http, needSecret } from './http.mjs';

const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const full = (m) => `${m.title}\n${m.text}`;

export const adapters = {
  async stdout(ctx, cfg, m) { ctx.log.info(`\n[알림] ${full(m)}`); return { ok: true }; },

  async macos(ctx, cfg, m) {
    if (process.platform !== 'darwin') return { ok: false, skipped: 'macOS 아님' };
    const esc = (s) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
    const r = await run('osascript', ['-e', `display notification "${esc(clip(m.text, 200))}" with title "${esc(m.title)}"`], { env: ctx.env, timeoutMs: 10000 });
    if (r.code !== 0) throw new Error('osascript 실패');
    return { ok: true };
  },

  async discord(ctx, cfg, m) {
    const url = needSecret(ctx, cfg, 'webhookEnv', 'discord');
    await http(ctx, url, { json: { content: clip(full(m), 1900) } });
    return { ok: true };
  },

  async slack(ctx, cfg, m) {
    const url = needSecret(ctx, cfg, 'webhookEnv', 'slack');
    await http(ctx, url, { json: { text: clip(full(m), 3000) } });
    return { ok: true };
  },

  async telegram(ctx, cfg, m) {
    const token = needSecret(ctx, cfg, 'tokenEnv', 'telegram');
    const chat = cfg.chatId || needSecret(ctx, cfg, 'chatIdEnv', 'telegram');
    const base = cfg.apiBase || 'https://api.telegram.org';
    await http(ctx, `${base}/bot${token}/sendMessage`, { json: { chat_id: chat, text: clip(full(m), 4000) } });
    return { ok: true };
  },

  async ntfy(ctx, cfg, m) {
    const url = cfg.url || needSecret(ctx, cfg, 'urlEnv', 'ntfy');
    await http(ctx, url, { body: clip(m.text, 3000), headers: { Title: encodeURIComponent(m.title) } });
    return { ok: true };
  },

  async email(ctx, cfg, m) {
    const to = cfg.to;
    if (!to) throw new Error('email: config.to 가 없습니다');
    const subject = m.title;
    if (which('gws', ctx.env)) {
      const r = await run('gws', ['gmail', '+send', '--to', to, '--subject', subject, '--body', m.text], { env: ctx.env, timeoutMs: 60000 });
      if (r.code !== 0) throw new Error('gws gmail 발송 실패');
      return { ok: true, via: 'gws' };
    }
    if (which('aws', ctx.env) && cfg.from) {
      const content = JSON.stringify({ Simple: { Subject: { Data: subject }, Body: { Text: { Data: m.text } } } });
      const args = ['sesv2', 'send-email', '--from-email-address', cfg.from, '--destination', `ToAddresses=${to}`, '--content', content];
      if (cfg.region) args.push('--region', cfg.region);
      const r = await run('aws', args, { env: ctx.env, timeoutMs: 60000 });
      if (r.code !== 0) throw new Error('aws sesv2 발송 실패');
      return { ok: true, via: 'aws-ses' };
    }
    const sm = which('sendmail', ctx.env);
    if (sm) {
      const msg = `To: ${to}\nSubject: ${subject.replace(/[\r\n]/g, ' ')}\nContent-Type: text/plain; charset=UTF-8\n\n${m.text}\n`;
      const r = await run(sm, ['-t'], { input: msg, env: ctx.env, timeoutMs: 30000 });
      if (r.code !== 0) throw new Error('sendmail 실패');
      return { ok: true, via: 'sendmail' };
    }
    ctx.log.warn('email: gws / aws(+config.from) / sendmail 중 쓸 수 있는 것이 없어 건너뜁니다');
    return { ok: false, skipped: 'no mail transport' };
  },
};
