#!/usr/bin/env node
// Sends test emails to the n8n webhook one at a time (waits for each result),
// saves the raw results and scores them against tests/expected.json.
//
//   node scripts/run_eval.js --version v2                 # all 25
//   node scripts/run_eval.js --version v1 --only E01,E03  # subset
//   node scripts/run_eval.js --score-only results/v2.json # re-score a saved run
//
// Env: WEBHOOK_URL (default http://localhost:5678/webhook/kesar-support)

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i === -1 ? d : args[i + 1]; };
const version = arg('--version', 'v2');
const only = arg('--only', null);
const delayMs = Number(arg('--delay', '3000'));
const scoreOnly = arg('--score-only', null);
const url = process.env.WEBHOOK_URL || 'http://localhost:5678/webhook/kesar-support';

const emails = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/test_emails.json'), 'utf8')).emails;
const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/expected.json'), 'utf8'));

async function post(email) {
  const t0 = Date.now();
  const res = await fetch(`${url}?v=${version}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(email),
    signal: AbortSignal.timeout(240000),
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { _raw: text }; }
  if (Array.isArray(body)) body = body[0];
  return { http: res.status, ms: Date.now() - t0, body };
}

function score(results) {
  const rows = [];
  const m = { n: 0, intent: 0, protocol: 0, ticket: 0, needs_human: 0, nh_count: 0, json_first: 0, draft_check_ok: 0, all: 0, errors: 0 };
  for (const r of results) {
    const x = expected[r.id];
    const b = r.body || {};
    m.n++;
    if (b.error) m.errors++;
    const intentOk = b.intent === x.intent;
    const protocolOk = b.protocol === x.protocol;
    const ticketOp = b.ticket_op || null;
    const ticketOk = (x.ticket || null) === ticketOp;
    const nhOk = String(b.needs_human).toUpperCase() === String(x.needs_human).toUpperCase();
    const ok = intentOk && protocolOk && ticketOk && nhOk;
    m.intent += intentOk; m.protocol += protocolOk; m.ticket += ticketOk; m.needs_human += nhOk; m.all += ok;
    m.nh_count += String(b.needs_human).toUpperCase() === 'TRUE';
    m.json_first += b.json_valid_first_try === true;
    m.draft_check_ok += b.draft_check === 'pass' || b.draft_check === 'n/a';
    rows.push({ id: r.id, exp_intent: x.intent, got_intent: b.intent, exp_protocol: x.protocol, got_protocol: b.protocol,
      exp_ticket: x.ticket, got_ticket: ticketOp, exp_nh: x.needs_human, got_nh: b.needs_human, ok, ms: r.ms,
      draft_check: b.draft_check, reasons: b.notes });
  }
  return { metrics: m, rows };
}

function printReport({ metrics: m, rows }) {
  const pad = (s, n) => String(s ?? '').padEnd(n);
  console.log(`\n${pad('id', 4)} ${pad('intent exp/got', 32)} ${pad('protocol exp/got', 40)} ${pad('ticket', 16)} ${pad('nh', 12)} ok`);
  for (const r of rows) {
    console.log(`${pad(r.id, 4)} ${pad(`${r.exp_intent}/${r.got_intent}`, 32)} ${pad(`${r.exp_protocol}/${r.got_protocol}`, 40)} ${pad(`${r.exp_ticket}/${r.got_ticket}`, 16)} ${pad(`${r.exp_nh}/${r.got_nh}`, 12)} ${r.ok ? 'PASS' : 'FAIL'}`);
  }
  const f = (k) => `${m[k]}/${m.n}`;
  console.log(`\nintent ${f('intent')} | protocol ${f('protocol')} | ticket ${f('ticket')} | needs_human ${f('needs_human')} | fully correct ${f('all')} | valid JSON 1st try ${f('json_first')} | draft check ok ${f('draft_check_ok')} | sent to human ${m.nh_count} | errors ${m.errors}`);
}

(async () => {
  if (scoreOnly) {
    const saved = JSON.parse(fs.readFileSync(scoreOnly, 'utf8'));
    printReport(score(saved.results));
    return;
  }
  const list = only ? emails.filter((e) => only.split(',').includes(e.id)) : emails;
  const results = [];
  for (const e of list) {
    process.stdout.write(`${e.id} ... `);
    try {
      const r = await post(e);
      results.push({ id: e.id, ...r });
      console.log(`${r.http} ${r.ms}ms ${r.body.intent || ''} -> ${r.body.protocol || r.body._raw || ''}`);
    } catch (err) {
      results.push({ id: e.id, http: 0, ms: 0, body: { error: String(err) } });
      console.log(`ERROR ${err}`);
    }
    await new Promise((s) => setTimeout(s, delayMs));
  }
  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  const out = path.join(ROOT, 'results', `${version}${only ? '_subset' : ''}.json`);
  const scored = score(results);
  fs.writeFileSync(out, JSON.stringify({ version, ran_at: new Date().toISOString(), metrics: scored.metrics, results }, null, 2));
  printReport(scored);
  console.log(`\nsaved ${path.relative(ROOT, out)}`);
})();
