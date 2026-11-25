#!/usr/bin/env node
// Loads the Groq key and Google service account from .env/.secrets into the local n8n
// credential store (encrypted by n8n). The temp file is deleted immediately.
//   node scripts/n8n_import_creds.js   (n8n should be stopped)
// Env: N8N_HOME (default C:/Aman/n8n-runtime)
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) { const m = l.match(/^(\w+)=(.*)$/); if (m) process.env[m[1]] ??= m[2].trim(); }
const N8N_HOME = process.env.N8N_HOME || 'C:/Aman/n8n-runtime';
const creds = [{ id: 'groqCred0000001', name: 'Groq (free tier)', type: 'groqApi', data: { apiKey: process.env.GROQ_API_KEY } }];
const saFile = path.resolve(ROOT, process.env.GOOGLE_SA_FILE || '.secrets/google-sa.json');
if (fs.existsSync(saFile)) {
  const sa = JSON.parse(fs.readFileSync(saFile, 'utf8'));
  creds.push({ id: 'googleSaCred001', name: 'Google Sheets (service account)', type: 'googleApi',
    data: { region: 'global', email: sa.client_email, privateKey: sa.private_key, inpersonate: false, httpNode: false } });
}
const tmp = path.join(os.tmpdir(), `n8n-creds-${process.pid}.json`);
try {
  fs.writeFileSync(tmp, JSON.stringify(creds), { mode: 0o600 });
  execSync(`npx n8n import:credentials --input="${tmp}"`, { cwd: N8N_HOME, stdio: 'inherit',
    env: Object.assign({}, process.env, { N8N_USER_FOLDER: path.join(N8N_HOME, 'data'), N8N_DIAGNOSTICS_ENABLED: 'false' }) });
  console.log('imported:', creds.map((c) => c.name).join(', '));
} finally { fs.rmSync(tmp, { force: true }); }
