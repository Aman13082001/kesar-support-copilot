#!/usr/bin/env node
// Reads REAL token usage per email from the local n8n execution database.
//   N8N_HOME=C:/Aman/n8n-runtime node scripts/token_usage.js [sinceISO]
// Needs n8n's bundled sqlite3 + flatted (resolved from N8N_HOME/node_modules).
const path = require('node:path');
const N8N_HOME = process.env.N8N_HOME || 'C:/Aman/n8n-runtime';
const req = (m) => require(path.join(N8N_HOME, 'node_modules', m));
const sqlite3 = req('sqlite3'); const { parse } = req('flatted');
const since = process.argv[2] || '1970-01-01';
const db = new sqlite3.Database(path.join(N8N_HOME, 'data/.n8n/database.sqlite'));
const PRICE = { // USD per 1M tokens, Groq on-demand list prices
  'gpt-oss-20b': { in: 0.075, out: 0.30 }, 'gpt-oss-120b': { in: 0.15, out: 0.60 },
};
db.all(`select e.id, e.startedAt, d.data from execution_entity e join execution_data d on d.executionId = e.id
        where e.workflowId = 'kesarCopilot0001' and e.status = 'success' and e.startedAt >= ? order by e.id`, [since], (err, rows) => {
  if (err) throw err;
  const per = [];
  for (const r of rows) {
    const d = parse(r.data); const rd = d.resultData.runData;
    const email = rd['Prepare'] && rd['Prepare'][0].data.main[0][0].json.email;
    const version = rd['Prepare'] && rd['Prepare'][0].data.main[0][0].json.cfg.version;
    let cIn = 0, cOut = 0, aIn = 0, aOut = 0, agentCalls = 0;
    for (const n of ['Classify (LLM)', 'Repair JSON (LLM retry)']) for (const run of rd[n] || []) {
      const u = run.data && run.data.main[0] && run.data.main[0][0] && run.data.main[0][0].json.usage;
      if (u) { cIn += u.prompt_tokens; cOut += u.completion_tokens; }
    }
    for (const run of rd['Groq gpt-oss-120b'] || []) {
      const u = run.data && run.data.ai_languageModel && run.data.ai_languageModel[0][0].json.tokenUsage;
      if (u) { aIn += u.promptTokens; aOut += u.completionTokens; agentCalls++; }
    }
    for (const run of rd['Redraft with verified facts (LLM)'] || []) {
      const u = run.data && run.data.main[0] && run.data.main[0][0] && run.data.main[0][0].json.usage;
      if (u) { aIn += u.prompt_tokens; aOut += u.completion_tokens; agentCalls++; }
    }
    const usd = (cIn * PRICE['gpt-oss-20b'].in + cOut * PRICE['gpt-oss-20b'].out + aIn * PRICE['gpt-oss-120b'].in + aOut * PRICE['gpt-oss-120b'].out) / 1e6;
    if (email) per.push({ exec: r.id, email: email.id, version, cIn, cOut, aIn, aOut, agentCalls, usd });
  }
  // keep the latest execution per email+version
  const latest = Object.values(Object.fromEntries(per.map((p) => [`${p.version}:${p.email}`, p])));
  for (const v of ['v1', 'v2']) {
    const L = latest.filter((p) => p.version === v);
    if (!L.length) continue;
    const sum = (k) => L.reduce((a, p) => a + p[k], 0);
    console.log(`\n${v}: ${L.length} emails`);
    for (const p of L) console.log(`  ${p.email} classify ${p.cIn}+${p.cOut}  agent ${p.aIn}+${p.aOut} (${p.agentCalls} calls)  $${p.usd.toFixed(5)}`);
    const n = L.length;
    console.log(`  avg tokens/email: classify ${Math.round(sum('cIn') / n)} in + ${Math.round(sum('cOut') / n)} out; agent ${Math.round(sum('aIn') / n)} in + ${Math.round(sum('aOut') / n)} out; total ${Math.round((sum('cIn') + sum('cOut') + sum('aIn') + sum('aOut')) / n)}`);
    console.log(`  avg cost/email at list price: $${(sum('usd') / n).toFixed(5)}  -> 30,000 emails/month: $${(sum('usd') / n * 30000).toFixed(2)}`);
  }
  db.close();
});
