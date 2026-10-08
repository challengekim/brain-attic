// Fake LLM runner for tests: reads the prompt on stdin, answers according to FAKE_LLM_MODE.
let input = '';
for await (const c of process.stdin) input += c;
const mode = process.env.FAKE_LLM_MODE || 'ok';
const ids = [...input.matchAll(/\{"id":"(i\d+)"/g)].map((m) => m[1]);
const proj = (/^프로젝트 목록:\n- (.*)$/m.exec(input) || [])[1] || null;
const out = (obj) => process.stdout.write(`잡담\n<<<JSON ${JSON.stringify(obj)} JSON>>>\n`);
if (mode === 'broken') process.stdout.write('죄송합니다 JSON 을 못 만들겠습니다');
else if (mode === 'badschema') out({ result: 'nope' });
else if (mode === 'fail') { process.stderr.write('boom'); process.exit(3); }
else if (mode === 'allc') out({ items: ids.map((id) => ({ id, class: 'c', project: proj, reason: '깊게 볼 가치', minutes: 100 })) });
else if (mode === 'partial') out({ items: [{ id: ids[0], class: 'a', project: null, reason: '인지만' }, { id: ids[1] || 'zz', class: 'x', reason: '잘못된 등급' }, { id: 'unknown', class: 'a', reason: '없는 id' }] });
else out({ items: ids.map((id, n) => ({ id, class: ['a', 'b', 'c'][n % 3], project: n % 3 === 2 ? proj : 'not in list', reason: `이유 ${id}`, ...(n % 3 === 2 ? { minutes: 40 } : {}) })) });
