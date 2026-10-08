// Fake LLM for teach tests. Reads the prompt on stdin, answers by prompt kind.
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (process.env.FAKE_TEACH_LOG) require_log(input);
  if (input.includes('튜터')) {
    const pack = {
      title: 'Prompt caching',
      explanation: 'Prompt caching stores the prompt prefix. If the prefix is the same, the model reads it from cache.',
      diagram_mermaid: 'flowchart LR\n  A[Prompt prefix] --> B[Cache]\n  B --> C[Cheaper read]',
      terms: [{ term: 'prefix', definition: 'The unchanged start of the prompt.' }],
      quiz: [
        { type: 'apply', question: 'Prefix changes. What happens?', choices: ['Cache hit', 'Cache miss', 'Error', 'Nothing'], answer: 1, why: 'A different prefix cannot be reused.' },
        { type: 'misconception', question: 'Caching changes the answer?', choices: ['Yes', 'No', 'Sometimes', 'Only on Fridays'], answer: 1, why: 'It only changes cost and latency.' },
      ],
      teach_back: [{ prompt: 'Explain caching to a teammate in 3 sentences.', rubric: ['same prefix', 'cheaper', 'answer unchanged'] }],
    };
    process.stdout.write(`thinking...\n<<<JSON ${JSON.stringify(pack)} JSON>>>\n`);
  } else {
    const answer = input.slice(input.lastIndexOf('<untrusted>'));
    const good = answer.includes('same prefix');
    const grade = good
      ? { scores: { accuracy: 4, completeness: 4, own_words: 3, example: 3 }, missing: [], wrong: [], feedback: 'Good.', follow_up: null }
      : { scores: { accuracy: 2, completeness: 1, own_words: 2, example: 0 }, missing: ['same prefix'], wrong: [], feedback: 'Say when the cache is used.', follow_up: 'When is the cache reused?' };
    process.stdout.write(`<<<JSON ${JSON.stringify(grade)} JSON>>>`);
  }
});
function require_log(text) {
  // Append each prompt so tests can inspect what the model saw.
  import('node:fs').then((fs) => fs.appendFileSync(process.env.FAKE_TEACH_LOG, `${text}\n=====\n`));
}
