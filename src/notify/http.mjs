// HTTP helper for notifiers. Error messages NEVER include the URL: webhook URLs and bot tokens live in the path.
export async function http(ctx, url, { method = 'POST', json, body, headers = {}, timeoutMs = 15000 } = {}) {
  const f = ctx.fetch || globalThis.fetch;
  const h = { 'user-agent': 'brain-attic/0.1', ...headers };
  let payload = body;
  if (json !== undefined) { payload = JSON.stringify(json); h['content-type'] = 'application/json'; }
  let res;
  try { res = await f(url, { method, headers: h, body: payload, signal: AbortSignal.timeout(timeoutMs) }); }
  catch (e) { throw new Error(`요청 실패: ${e.name === 'TimeoutError' ? '시간 초과' : '네트워크 오류'}`); }
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { /* not json */ }
  return { status: res.status, text, data };
}

export function needSecret(ctx, cfg, field, label) {
  const name = cfg[field];
  if (!name) throw new Error(`${label}: config 에 ${field} (환경변수 이름)가 없습니다`);
  const v = ctx.env[name];
  if (!v) throw new Error(`${label}: 환경변수 ${name} 가 비어 있습니다`);
  return v;
}
