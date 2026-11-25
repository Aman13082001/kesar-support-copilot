#!/usr/bin/env node
// Prepares the "Kesar Support" Google Sheet using the service account (no npm deps).
//   node scripts/setup_sheet.js            -> create missing tabs + write header rows
//   node scripts/setup_sheet.js --reset v2 -> clear data rows of "Audit Log" + "Tickets" (keeps headers)
//   node scripts/setup_sheet.js --reset v1 -> same for the "(v1)" tabs
//   node scripts/setup_sheet.js --dump     -> print current rows (for checking results)
// Env (.env): SHEET_ID, GOOGLE_SA_FILE
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) { const m = l.match(/^(\w+)=(.*)$/); if (m) process.env[m[1]] ??= m[2].trim(); }
const SHEET_ID = process.env.SHEET_ID;
const sa = JSON.parse(fs.readFileSync(path.resolve(ROOT, process.env.GOOGLE_SA_FILE || '.secrets/google-sa.json'), 'utf8'));
const csvHeader = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8').split(/\r?\n/)[0].split(',');
const AUDIT = csvHeader('templates/audit_log_template.csv');
const TICKETS = csvHeader('templates/tickets_template.csv');
const TABS = { 'Audit Log': AUDIT, Tickets: TICKETS, 'Audit Log (v1)': AUDIT, 'Tickets (v1)': TICKETS };

async function token() {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/spreadsheets', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  const sig = crypto.createSign('RSA-SHA256').update(unsigned).sign(sa.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${unsigned}.${sig}` });
  const j = await r.json(); if (!j.access_token) throw new Error('auth failed: ' + JSON.stringify(j)); return j.access_token;
}

(async () => {
  const t = await token();
  const api = async (p, opt = {}) => {
    const r = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}${p}`, Object.assign({ headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' } }, opt));
    const j = await r.json(); if (!r.ok) throw new Error(`${p}: ${JSON.stringify(j.error || j)}`); return j;
  };
  const meta = await api('?fields=properties.title,sheets.properties');
  const existing = meta.sheets.map((s) => s.properties.title);
  const args = process.argv.slice(2);
  if (args.includes('--dump')) {
    for (const tab of ['Audit Log', 'Tickets', 'Audit Log (v1)', 'Tickets (v1)']) {
      if (!existing.includes(tab)) continue;
      const v = await api(`/values/${encodeURIComponent(`'${tab}'`)}`);
      console.log(`\n== ${tab}: ${(v.values || []).length - 1} data rows`);
      for (const row of (v.values || []).slice(0, 40)) console.log(row.map((c) => String(c).replace(/\n/g, ' ').slice(0, 40)).join(' | '));
    }
    return;
  }
  const missing = Object.keys(TABS).filter((tab) => !existing.includes(tab));
  if (missing.length) await api(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }) });
  if (args.includes('--reset')) {
    const v = args[args.indexOf('--reset') + 1];
    const tabs = v === 'v1' ? ['Audit Log (v1)', 'Tickets (v1)'] : ['Audit Log', 'Tickets'];
    for (const tab of tabs) await api(`/values/${encodeURIComponent(`'${tab}'!A2:Z1000`)}:clear`, { method: 'POST', body: '{}' });
    console.log('cleared', tabs.join(', '));
  }
  await api('/values:batchUpdate', { method: 'POST', body: JSON.stringify({ valueInputOption: 'RAW',
    data: Object.entries(TABS).map(([tab, cols]) => ({ range: `'${tab}'!A1`, values: [cols] })) }) });
  console.log(`sheet "${meta.properties.title}": tabs ok (${Object.keys(TABS).join(', ')}), headers written; created: ${missing.join(', ') || 'none'}`);
  console.log(`share check: service account ${sa.client_email} has edit access`);
})().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
