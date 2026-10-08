// Like fake-llm 'ok' but every prompt is appended to $FAKE_LLM_LOG, and every item becomes class a.
import fs from 'node:fs';
let input = '';
for await (const c of process.stdin) input += c;
if (process.env.FAKE_LLM_LOG) fs.appendFileSync(process.env.FAKE_LLM_LOG, input + '\n=====\n');
const ids = [...input.matchAll(/\{"id":"(i\d+)"/g)].map((m) => m[1]);
process.stdout.write(`<<<JSON ${JSON.stringify({ items: ids.map((id, n) => ({ id, class: ['a', 'b', 'c', 'd'][n % 4], project: null, reason: `이유 ${id}`, ...(n % 4 === 2 ? { minutes: 40 } : {}) })) })} JSON>>>\n`);
