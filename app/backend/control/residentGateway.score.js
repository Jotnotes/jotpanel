'use strict';
// Scores the Resident's reading against the labelled set written by Codex.
//   node control/residentGateway.score.js              rules only
//   node control/residentGateway.score.js qwen2.5:7b   rules then that local model
const B = __dirname + '/';
const { createUnderstanding, MODEL_BRIEF } = require(B+'residentGateway');
const labels = require(B+'residentGateway.labels.json');
const model = process.argv[2];
const callModel = model ? async (system, text) => {
  const r = await fetch(process.env.OLLAMA_BASE || 'http://localhost:11434/v1/chat/completions', { method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ model, messages:[{role:'system',content:system},{role:'user',content:text}], max_tokens:60, temperature:0 }) });
  return (await r.json()).choices[0].message.content;
} : null;
(async () => {
  const understand = createUnderstanding({ callModel, budgetMs: 8000 });
  let role=0, state=0, how={}, ms=[]; const misses={};
  for (const l of labels) {
    const t=Date.now(); const r = await understand({ text: l.text }); ms.push(Date.now()-t);
    if (r.role===l.role) role++; else misses[l.role+'->'+r.role]=(misses[l.role+'->'+r.role]||0)+1;
    if (r.state===l.state) state++; how[r.how]=(how[r.how]||0)+1;
  }
  ms.sort((a,b)=>a-b);
  console.log(model||'rules only', '| role', (100*role/labels.length).toFixed(0)+'%', '| state', (100*state/labels.length).toFixed(0)+'%', '| how', JSON.stringify(how), '| p50', ms[ms.length>>1]+'ms p95', ms[Math.floor(ms.length*.95)]+'ms');
  console.log('  misses', JSON.stringify(misses));
})();
