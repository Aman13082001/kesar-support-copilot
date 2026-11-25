#!/usr/bin/env node
// Dev helper: run ONLY the classification prompt against Groq for some emails and
// validate against the schema. Used to iterate on prompts before wiring n8n.
//   node scripts/probe_classify.js v2 E01,E05,E12
const fs = require('node:fs');
const path = require('node:path');
const P = require('../code/policy.js');
const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) { const m = l.match(/^(\w+)=(.*)$/); if (m) process.env[m[1]] ??= m[2].trim(); }

const [version = 'v2', only] = process.argv.slice(2);
const tpl = fs.readFileSync(path.join(ROOT, `prompts/classify_${version}.md`), 'utf8');
const emails = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/test_emails.json'), 'utf8')).emails
  .filter((e) => !only || only.split(',').includes(e.id));
const expected = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests/expected.json'), 'utf8'));

function render(e) {
  const fill = (s) => s.replace('{{from_name}}', e.from.name).replace('{{from_email}}', e.from.email)
    .replace('{{subject}}', e.subject).replace('{{attachments}}', e.attachments.join(', ') || 'none').replace('{{body}}', e.body);
  const [sys, user] = tpl.includes('USER:') ? tpl.replace(/^SYSTEM:\n/, '').split('\nUSER:\n') : [null, tpl];
  return [sys && { role: 'system', content: sys }, { role: 'user', content: fill(user) }].filter(Boolean);
}

(async () => {
  let ok = 0, valid = 0;
  for (const e of emails) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.GROQ_MODEL_CLASSIFY, temperature: 0, reasoning_effort: 'low',
        response_format: { type: 'json_object' }, messages: render(e) }),
    });
    const j = await res.json();
    if (!res.ok) { console.log(e.id, 'HTTP', res.status, JSON.stringify(j).slice(0, 200)); await new Promise((s) => setTimeout(s, 8000)); continue; }
    const v = P.validateClassification(j.choices[0].message.content);
    valid += v.valid;
    const c = v.value || {};
    const hit = c.intent === expected[e.id].intent; ok += hit;
    console.log(`${e.id} ${v.valid ? 'valid' : 'INVALID ' + v.errors}  ${c.intent}/${expected[e.id].intent} ${hit ? '' : '<-- MISS'}  ${c.language} ${c.sentiment} conf=${c.confidence} issue=${c.issue_type} cond=${c.item_condition} other=${c.other_type} inj=${c.injection_suspected} tok=${j.usage.total_tokens}`);
    await new Promise((s) => setTimeout(s, 2500));
  }
  console.log(`valid ${valid}/${emails.length}, intent ${ok}/${emails.length}`);
})();
