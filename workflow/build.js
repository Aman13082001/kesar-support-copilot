#!/usr/bin/env node
// Generates the n8n workflow JSON from code/policy.js + prompts/*.md so the
// unit-tested logic and the workflow can never drift apart.
//
//   node workflow/build.js                 -> workflow/kesar_support_copilot.json (Google Sheets)
//   node workflow/build.js --store memory  -> workflow/dev_memory.json (no Sheets; dev only)
//
// Reads SHEET_ID from .env (the sheet is shared view-only in the README, so it is not a secret).
// Credentials are referenced by name/id only; keys live in n8n's credential store.

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const store = args.includes('--store') ? args[args.indexOf('--store') + 1] : 'sheets';
const env = {};
try {
  for (const l of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const m = l.match(/^(\w+)=(.*)$/); if (m) env[m[1]] = m[2].trim();
  }
} catch { /* no .env: placeholders */ }

const SHEET_ID = env.SHEET_ID || 'PASTE_YOUR_GOOGLE_SHEET_ID';
const MODEL_CLASSIFY = env.GROQ_MODEL_CLASSIFY || 'openai/gpt-oss-20b';
const MODEL_AGENT = env.GROQ_MODEL_AGENT || 'openai/gpt-oss-120b';
const ORDERS_URL = 'https://raw.githubusercontent.com/abhishek-patel-cadient/kesar-ai-copilot-assignment/refs/heads/main/data/orders.json';
const FAQ_URL = 'https://raw.githubusercontent.com/abhishek-patel-cadient/kesar-ai-copilot-assignment/refs/heads/main/data/faq.md';

const LIB = fs.readFileSync(path.join(ROOT, 'code/policy.js'), 'utf8');
const PROMPTS = Object.fromEntries(['classify_v1', 'classify_v2', 'agent_v1', 'agent_v2']
  .map((k) => [k, fs.readFileSync(path.join(ROOT, `prompts/${k}.md`), 'utf8')]));

const GROQ_CRED = { groqApi: { id: 'groqCred0000001', name: 'Groq (free tier)' } };
const SHEETS_CRED = { googleApi: { id: 'googleSaCred001', name: 'Google Sheets (service account)' } };

const AUDIT_COLS = ['email_id', 'received_at', 'from_email', 'intent', 'secondary_intent', 'order_id', 'language', 'sentiment',
  'confidence', 'order_found', 'action_taken', 'needs_human', 'ticket_id', 'reply_draft', 'prompt_version', 'processed_at', 'error', 'notes'];
const TICKET_COLS = ['ticket_id', 'created_at', 'updated_at', 'order_id', 'customer_email', 'email_ids', 'intent', 'priority', 'status', 'summary', 'notes'];

// ------------------------------------------------------------------ code node bodies

const code = (body) => `${LIB}\n\n// ======== node logic ========\n${body}`;

const PREPARE = `
const PROMPTS = ${JSON.stringify(PROMPTS)};
const hook = $input.first().json;
const email = hook.body || {};
const version = (hook.query && hook.query.v === 'v1') ? 'v1' : 'v2';
if (!email.id || !email.from || !email.from.email || typeof email.body !== 'string') {
  throw new Error('Bad request: expected one email object like data/test_emails.json');
}
email.attachments = email.attachments || [];
const cfg = {
  version,
  audit_tab: version === 'v1' ? 'Audit Log (v1)' : 'Audit Log',
  tickets_tab: version === 'v1' ? 'Tickets (v1)' : 'Tickets',
  model_classify: ${JSON.stringify(MODEL_CLASSIFY)},
  model_agent: ${JSON.stringify(MODEL_AGENT)},
};
function render(tpl) {
  const fill = (s) => s.split('{{from_name}}').join(email.from.name || '')
    .split('{{from_email}}').join(email.from.email)
    .split('{{subject}}').join(email.subject || '')
    .split('{{attachments}}').join(email.attachments.join(', ') || 'none')
    .split('{{body}}').join(email.body);
  if (!tpl.includes('\\nUSER:\\n')) return [{ role: 'user', content: fill(tpl) }];
  const [sys, user] = tpl.replace(/^SYSTEM:\\n/, '').split('\\nUSER:\\n');
  return [{ role: 'system', content: sys }, { role: 'user', content: fill(user) }];
}
const messages = render(PROMPTS['classify_' + version]);
return [{ json: {
  email, cfg, agent_template: PROMPTS['agent_' + version],
  cls_body: { model: cfg.model_classify, temperature: 0, reasoning_effort: 'low', max_tokens: 1200,
    response_format: { type: 'json_object' }, messages },
} }];
`;

const VALIDATE_FIRST = `
const prep = $('Prepare').first().json;
const res = $input.first().json;
const raw = res.choices && res.choices[0] && res.choices[0].message ? res.choices[0].message.content : null;
const v = raw ? validateClassification(raw) : { valid: false, errors: [res.error ? 'API error: ' + JSON.stringify(res.error).slice(0, 200) : 'empty response'] };
const tokens = (res.usage && res.usage.total_tokens) || 0;
const repair_body = Object.assign({}, prep.cls_body, { messages: prep.cls_body.messages.concat(
  raw ? [{ role: 'assistant', content: String(raw).slice(0, 2000) }] : [],
  [{ role: 'user', content: 'Your previous output was not valid (' + v.errors.join('; ') + '). Return ONLY the corrected JSON object with all required keys.' }]) });
return [{ json: { valid: v.valid, cls: v.value, errors: v.errors, json_valid_first_try: v.valid, tokens_classify: tokens, repair_body } }];
`;

const VALIDATE_RETRY = `
const prep = $('Prepare').first().json;
const first = $('Validate JSON').first().json;
const res = $input.first().json;
const raw = res.choices && res.choices[0] && res.choices[0].message ? res.choices[0].message.content : null;
const v = raw ? validateClassification(raw) : { valid: false, errors: ['retry failed'] };
const cls = v.valid ? v.value : fallbackClassification(prep.email, 'invalid after retry: ' + first.errors.concat(v.errors).join('; '));
return [{ json: { valid: v.valid, cls, errors: first.errors.concat(v.errors), json_valid_first_try: false,
  tokens_classify: first.tokens_classify + ((res.usage && res.usage.total_tokens) || 0) } }];
`;

const DECIDE = `
const prep = $('Prepare').first().json;
const c = $input.first().json;
const orders = $('Get orders').first().json.orders;
const email = prep.email;
const decision = decide({ email, cls: c.cls, orders });
// Agent prompt: v2 gets the policy-engine brief; v1 is the naive first version.
const fill = (s) => s.split('{{from_name}}').join(email.from.name || '').split('{{from_email}}').join(email.from.email)
  .split('{{subject}}').join(email.subject || '').split('{{attachments}}').join(email.attachments.join(', ') || 'none')
  .split('{{body}}').join(email.body).split('{{brief}}').join(decision.brief);
let agent_system, agent_user;
if (prep.agent_template.includes('\\nUSER:\\n')) {
  const [sys, user] = prep.agent_template.replace(/^SYSTEM:\\n/, '').split('\\nUSER:\\n');
  agent_system = sys; agent_user = fill(user);
} else {
  agent_system = 'You are a helpful assistant.'; agent_user = fill(prep.agent_template);
}
return [{ json: Object.assign({}, c, { decision, protocol: decision.protocol, agent_system, agent_user }) }];
`;

const TOOL_GET_ORDER = `
${LIB}
// Identity is bound HERE from the webhook sender, never from the model's arguments.
const sender = $('Prepare').first().json.email.from.email;
const orders = $('Get orders').first().json.orders;
const id = String(query || '').match(/KC-\\d{4}/i);
const r = getOrderTool(orders, id ? id[0] : null, sender);
return JSON.stringify(r);
`;

const TOOL_SEARCH_FAQ = `
${LIB}
const faq = $('Get FAQ').first().json.data;
return searchFaq(faq, String(query || ''), 2);
`;

const CHECK_DRAFT = `
const d = $('Decide').first().json;
const prep = $('Prepare').first().json;
const faq = $('Get FAQ').first().json.data;
const orders = $('Get orders').first().json.orders;
const draft = String($input.first().json.output || '').trim();
const agentError = $input.first().json.error ? String($input.first().json.error.message || $input.first().json.error).slice(0, 200) : null;
const order = d.decision.identity_ok && d.decision.order_id ? orders.find((o) => o.order_id === d.decision.order_id) : null;
const facts = order ? safeOrderFacts(order) : null;
const chk = checkDraft(draft, { decision: d.decision, faqText: faq, orderFacts: facts, email: prep.email });
// Redraft request: same rules, the verified facts are supplied directly so the model cannot drift.
const redraft_body = {
  model: prep.cfg.model_agent, temperature: 0.2, reasoning_effort: 'low', max_tokens: 1500,
  messages: [
    { role: 'system', content: d.agent_system },
    { role: 'user', content: d.agent_user + '\\n\\nVERIFIED ORDER DATA (use only this): ' + (facts ? JSON.stringify(facts) : 'none / not allowed') +
      '\\n\\nRELEVANT FAQ: ' + searchFaq(faq, prep.email.subject + ' ' + prep.email.body, 2) +
      '\\n\\nYour previous draft was rejected by the fact checker: ' + (chk.problems.join('; ') || agentError || 'empty') + '. Write a corrected draft.' },
  ],
};
return [{ json: { stage: 'checked', draft, check_ok: chk.ok, problems: chk.problems, needs_human_token: chk.needs_human_token, agent_error: agentError, redraft_body } }];
`;

const FINALIZE = `
const d = $('Decide').first().json;
const prep = $('Prepare').first().json;
const faq = $('Get FAQ').first().json.data;
const orders = $('Get orders').first().json.orders;
const input = $input.first().json;
const decision = d.decision;
let draft = '', draft_check = 'n/a', problems = [], extraReasons = [];
if (decision.action === 'log_only') {
  draft = '';
} else if (input.stage === 'checked' && input.check_ok) {
  draft = input.draft; draft_check = 'pass';
  if (input.needs_human_token) extraReasons.push('agent_says_faq_not_covered');
} else {
  // came back from the redraft call
  const first = $('Check draft').first().json;
  const raw = input.choices && input.choices[0] ? String(input.choices[0].message.content || '').trim() : '';
  const order = decision.identity_ok && decision.order_id ? orders.find((o) => o.order_id === decision.order_id) : null;
  const chk = checkDraft(raw, { decision, faqText: faq, orderFacts: order ? safeOrderFacts(order) : null, email: prep.email });
  if (chk.ok) {
    draft = raw; draft_check = 'pass_after_redraft'; problems = first.problems;
    if (chk.needs_human_token) extraReasons.push('agent_says_faq_not_covered');
  } else {
    draft = safeHoldingDraft(prep.email, decision.reply_language);
    draft_check = 'failed_twice_safe_holding_reply'; problems = first.problems.concat(chk.problems);
    extraReasons.push('draft_failed_fact_check');
  }
}
draft = draft.replace(/\\[NEEDS_HUMAN\\]\\s*/g, '');
const reasons = decision.reasons.concat(extraReasons);
const needs_human = decision.needs_human || extraReasons.length > 0;
return [{ json: { draft, draft_check, problems, reasons, needs_human, ticket_needed: !!decision.ticket } }];
`;

const PLAN_TICKET = `
const d = $('Decide').first().json;
const prep = $('Prepare').first().json;
const rows = $input.all().map((i) => i.json).filter((r) => r && r.ticket_id);
const plan = planTicket(rows, { email: prep.email, cls: d.cls, decision: d.decision, nowIso: new Date().toISOString() });
const row = {};
for (const k of ${JSON.stringify(TICKET_COLS)}) row[k] = plan.row[k] === undefined || plan.row[k] === null ? '' : String(plan.row[k]);
if (plan.row.row_number) row.row_number = plan.row.row_number;
return [{ json: Object.assign({ _op: plan.op }, row) }];
`;

const AUDIT_ROW = `
const prep = $('Prepare').first().json;
const d = $('Decide').first().json;
const f = $('Finalize').first().json;
const ticket = $('Plan ticket').isExecuted ? $('Plan ticket').first().json : null;
const e = prep.email, c = d.cls, dec = d.decision;
const actions = { log_only: 'log only (no reply)', order_status: 'draft reply (order status)', product_query: 'draft reply (FAQ answer)',
  return_refund: 'ticket + draft reply (return/refund policy)', damage_claim: 'ticket + draft reply (damaged/wrong/missing)',
  complaint: 'ticket + draft acknowledgement', privacy_mismatch: 'privacy-safe draft (no order details)',
  ask_clarification: 'draft asking for order details', partnership: 'draft redirect to partnerships',
  escalate_other: 'holding draft, routed to human' };
let action = actions[dec.protocol] || dec.protocol;
if (ticket) action += ticket._op === 'update' ? ' [updated ' + ticket.ticket_id + ']' : ' [created ' + ticket.ticket_id + ']';
if (f.needs_human) action += ' -> needs human';
const notes = ['protocol=' + dec.protocol, dec.eligibility ? 'eligibility=' + (dec.eligibility.next_step) : null,
  f.reasons.length ? 'flags=' + f.reasons.join(',') : null, 'draft_check=' + f.draft_check,
  f.problems.length ? 'checker=' + f.problems.join(' / ').slice(0, 300) : null,
  'tokens_classify=' + d.tokens_classify].filter(Boolean).join(' | ');
const row = {
  email_id: e.id, received_at: e.received_at, from_email: e.from.email, intent: c.intent, secondary_intent: c.secondary_intent || '',
  order_id: dec.order_id || '', language: c.language, sentiment: c.sentiment, confidence: c.confidence,
  order_found: dec.order_found ? 'TRUE' : 'FALSE', action_taken: action, needs_human: f.needs_human ? 'TRUE' : 'FALSE',
  ticket_id: ticket ? ticket.ticket_id : '', reply_draft: f.draft, prompt_version: prep.cfg.version,
  processed_at: new Date().toISOString(), error: c._fallback ? c._fallback_reason : (d.errors && d.errors.length && !d.json_valid_first_try ? 'first JSON invalid: ' + d.errors.join('; ') : ''),
  notes,
};
return [{ json: row }];
`;

const RESULT = `
const row = $('Build audit row').first().json;
const d = $('Decide').first().json;
const f = $('Finalize').first().json;
const ticket = $('Plan ticket').isExecuted ? $('Plan ticket').first().json : null;
return [{ json: Object.assign({}, row, { protocol: d.decision.protocol, reasons: f.reasons, ticket_op: ticket ? ticket._op : null,
  ticket_priority: ticket ? ticket.priority : null, json_valid_first_try: d.json_valid_first_try, draft_check: f.draft_check,
  eligibility: d.decision.eligibility, cls: d.cls }) }];
`;

// dev-only stand-ins for Google Sheets (workflow static data)
const MEM_READ = `const s = $getWorkflowStaticData('global'); const tab = $('Prepare').first().json.cfg.tickets_tab;
const rows = (s[tab] || []); return rows.length ? rows.map((r) => ({ json: r })) : [{ json: {} }];`;
const MEM_WRITE_TICKET = `const s = $getWorkflowStaticData('global'); const tab = $('Prepare').first().json.cfg.tickets_tab;
const r = Object.assign({}, $input.first().json); delete r._op; s[tab] = s[tab] || [];
const i = s[tab].findIndex((x) => x.ticket_id === r.ticket_id); if (i >= 0) s[tab][i] = r; else s[tab].push(r);
return [{ json: r }];`;
const MEM_APPEND_AUDIT = `const s = $getWorkflowStaticData('global'); const tab = $('Prepare').first().json.cfg.audit_tab;
s[tab] = s[tab] || []; s[tab].push($input.first().json); return [{ json: $input.first().json }];`;

// ------------------------------------------------------------------ node helpers

let idn = 0;
const nodes = [];
const connections = {};
function node(name, type, typeVersion, position, parameters, extra = {}) {
  nodes.push(Object.assign({ id: `n${String(++idn).padStart(3, '0')}-kesar`, name, type, typeVersion, position, parameters }, extra));
  return name;
}
function link(from, to, outIndex = 0, kind = 'main') {
  connections[from] = connections[from] || {};
  connections[from][kind] = connections[from][kind] || [];
  while (connections[from][kind].length <= outIndex) connections[from][kind].push([]);
  connections[from][kind][outIndex].push({ node: to, type: kind, index: 0 });
}
const codeNode = (name, pos, js, extra) => node(name, 'n8n-nodes-base.code', 2, pos, { jsCode: js }, extra);
const cond = (left, operator, right) => ({
  conditions: {
    options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
    conditions: [Object.assign({ id: `c${++idn}`, leftValue: left, operator }, right === undefined ? {} : { rightValue: right })],
    combinator: 'and',
  },
});
const ifNode = (name, pos, left, operator, right) => node(name, 'n8n-nodes-base.if', 2.2, pos, Object.assign(cond(left, operator, right), { options: {} }));
const isTrue = { type: 'boolean', operation: 'true', singleValue: true };
const groqHttp = (name, pos, bodyExpr) => node(name, 'n8n-nodes-base.httpRequest', 4.2, pos, {
  method: 'POST', url: 'https://api.groq.com/openai/v1/chat/completions',
  authentication: 'predefinedCredentialType', nodeCredentialType: 'groqApi',
  sendBody: true, specifyBody: 'json', jsonBody: `={{ JSON.stringify(${bodyExpr}) }}`,
  options: { timeout: 60000 },
}, { credentials: GROQ_CRED, retryOnFail: true, maxTries: 5, waitBetweenTries: 5000, onError: 'continueRegularOutput' });
const sheetRef = (tabExpr) => ({
  documentId: { __rl: true, mode: 'id', value: SHEET_ID },
  sheetName: { __rl: true, mode: 'name', value: tabExpr },
});
const schema = (cols) => cols.map((c) => ({ id: c, displayName: c, required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true }));
const sheetsNode = (name, pos, operation, tabExpr, cols, extraParams = {}, extra = {}) => node(name, 'n8n-nodes-base.googleSheets', 4.7, pos,
  Object.assign({ authentication: 'serviceAccount', resource: 'sheet', operation }, sheetRef(tabExpr),
    cols ? { columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: operation === 'update' ? ['ticket_id'] : [], schema: schema(cols), attemptToConvertTypes: false, convertFieldsToString: true } } : {},
    extraParams),
  // Writes (append/update) are NOT idempotent: retrying them duplicated audit rows in testing, so only reads retry.
  Object.assign({ credentials: SHEETS_CRED }, operation === 'read' ? { retryOnFail: true, maxTries: 3, waitBetweenTries: 3000 } : {}, extra));

// ------------------------------------------------------------------ graph

const X = (i) => i * 260;
node('Email In (webhook)', 'n8n-nodes-base.webhook', 2.1, [X(0), 300],
  { httpMethod: 'POST', path: 'kesar-support', responseMode: 'responseNode', options: {} }, { webhookId: 'kesar-support-webhook' });
codeNode('Prepare', [X(1), 300], code(PREPARE));
node('Get orders', 'n8n-nodes-base.httpRequest', 4.2, [X(2), 300], { url: ORDERS_URL, options: { response: { response: { responseFormat: 'json' } } } }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 });
node('Get FAQ', 'n8n-nodes-base.httpRequest', 4.2, [X(3), 300], { url: FAQ_URL, options: { response: { response: { responseFormat: 'text' } } } }, { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 });
groqHttp('Classify (LLM)', [X(4), 300], "$('Prepare').first().json.cls_body");
codeNode('Validate JSON', [X(5), 300], code(VALIDATE_FIRST));
ifNode('Valid JSON?', [X(6), 300], '={{ $json.valid }}', isTrue);
groqHttp('Repair JSON (LLM retry)', [X(6), 520], '$json.repair_body');
codeNode('Validate retry / fallback', [X(7), 520], code(VALIDATE_RETRY));
codeNode('Decide', [X(8), 300], code(DECIDE));

const routes = [
  ['order_status', ['order_status']],
  ['product_query', ['product_query']],
  ['return_or_damage', ['return_refund', 'damage_claim', 'complaint']],
  ['clarify_privacy_escalate', ['privacy_mismatch', 'ask_clarification', 'escalate_other', 'partnership']],
  ['log_only', ['log_only']],
];
node('Route by protocol', 'n8n-nodes-base.switch', 3.2, [X(9), 300], {
  rules: {
    values: routes.map(([key, protos]) => ({
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [{ id: `r-${key}`, leftValue: `={{ ${JSON.stringify(protos)}.includes($json.protocol) }}`, operator: isTrue }],
        combinator: 'and',
      },
      renameOutput: true, outputKey: key,
    })),
  },
  options: {},
});

node('Draft reply (AI agent)', '@n8n/n8n-nodes-langchain.agent', 3.1, [X(10), 220], {
  promptType: 'define', text: '={{ $json.agent_user }}',
  options: { systemMessage: '={{ $json.agent_system }}', maxIterations: 6, enableStreaming: false },
}, { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000, onError: 'continueRegularOutput' });
node('Groq gpt-oss-120b', '@n8n/n8n-nodes-langchain.lmChatGroq', 1, [X(10) - 120, 460],
  { model: MODEL_AGENT, options: { temperature: 0.2, maxTokensToSample: 1500 } }, { credentials: GROQ_CRED });
node('get_order', '@n8n/n8n-nodes-langchain.toolCode', 1.3, [X(10) + 20, 460], {
  description: 'Look up an order. Input: the order ID (format KC-####), or the word "sender" to look up by the sender\'s email when no ID was given. Returns order status, items, amounts, courier, tracking link and dates, or an error (not found / PRIVACY). Only data for the sender\'s own orders is returned.',
  language: 'javaScript', jsCode: TOOL_GET_ORDER,
});
node('search_faq', '@n8n/n8n-nodes-langchain.toolCode', 1.3, [X(10) + 160, 460], {
  description: 'Search the official Kesar & Co. FAQ (shipping, COD, cancellation, returns, damaged/wrong/missing items, refunds, products, medical safety, contact). Input: a short search query. Returns the matching FAQ sections verbatim, or says the FAQ does not cover it.',
  language: 'javaScript', jsCode: TOOL_SEARCH_FAQ,
});
codeNode('Check draft', [X(11), 220], code(CHECK_DRAFT));
ifNode('Draft passes fact check?', [X(12), 220], '={{ $json.check_ok }}', isTrue);
groqHttp('Redraft with verified facts (LLM)', [X(12), 440], '$json.redraft_body');
codeNode('Finalize', [X(13), 300], code(FINALIZE));
ifNode('Ticket needed?', [X(14), 300], '={{ $json.ticket_needed }}', isTrue);

if (store === 'memory') {
  codeNode('Read tickets', [X(15), 180], MEM_READ);
  codeNode('Plan ticket', [X(16), 180], code(PLAN_TICKET));
  ifNode('Existing open ticket?', [X(17), 180], '={{ $json._op }}', { type: 'string', operation: 'equals' }, 'update');
  codeNode('Update ticket', [X(18), 80], MEM_WRITE_TICKET);
  codeNode('Create ticket', [X(18), 280], MEM_WRITE_TICKET);
} else {
  sheetsNode('Read tickets', [X(15), 180], 'read', "={{ $('Prepare').first().json.cfg.tickets_tab }}", null, { options: {} }, { alwaysOutputData: true });
  codeNode('Plan ticket', [X(16), 180], code(PLAN_TICKET));
  ifNode('Existing open ticket?', [X(17), 180], '={{ $json._op }}', { type: 'string', operation: 'equals' }, 'update');
  sheetsNode('Update ticket', [X(18), 80], 'update', "={{ $('Prepare').first().json.cfg.tickets_tab }}", TICKET_COLS, { options: { handlingExtraData: 'ignoreIt' } });
  sheetsNode('Create ticket', [X(18), 280], 'append', "={{ $('Prepare').first().json.cfg.tickets_tab }}", TICKET_COLS, { options: { handlingExtraData: 'ignoreIt' } });
}
codeNode('Build audit row', [X(19), 400], code(AUDIT_ROW));
if (store === 'memory') codeNode('Append audit log', [X(20), 400], MEM_APPEND_AUDIT);
else sheetsNode('Append audit log', [X(20), 400], 'append', "={{ $('Prepare').first().json.cfg.audit_tab }}", AUDIT_COLS, { options: { handlingExtraData: 'ignoreIt' } });
codeNode('Result', [X(21), 400], RESULT);
node('Respond', 'n8n-nodes-base.respondToWebhook', 1.5, [X(22), 400], { respondWith: 'allIncomingItems', options: {} });

// main flow
link('Email In (webhook)', 'Prepare');
link('Prepare', 'Get orders');
link('Get orders', 'Get FAQ');
link('Get FAQ', 'Classify (LLM)');
link('Classify (LLM)', 'Validate JSON');
link('Validate JSON', 'Valid JSON?');
link('Valid JSON?', 'Decide', 0);
link('Valid JSON?', 'Repair JSON (LLM retry)', 1);
link('Repair JSON (LLM retry)', 'Validate retry / fallback');
link('Validate retry / fallback', 'Decide');
link('Decide', 'Route by protocol');
routes.forEach(([key], i) => link('Route by protocol', key === 'log_only' ? 'Finalize' : 'Draft reply (AI agent)', i));
link('Groq gpt-oss-120b', 'Draft reply (AI agent)', 0, 'ai_languageModel');
link('get_order', 'Draft reply (AI agent)', 0, 'ai_tool');
link('search_faq', 'Draft reply (AI agent)', 0, 'ai_tool');
link('Draft reply (AI agent)', 'Check draft');
link('Check draft', 'Draft passes fact check?');
link('Draft passes fact check?', 'Finalize', 0);
link('Draft passes fact check?', 'Redraft with verified facts (LLM)', 1);
link('Redraft with verified facts (LLM)', 'Finalize');
link('Finalize', 'Ticket needed?');
link('Ticket needed?', 'Read tickets', 0);
link('Ticket needed?', 'Build audit row', 1);
link('Read tickets', 'Plan ticket');
link('Plan ticket', 'Existing open ticket?');
link('Existing open ticket?', 'Update ticket', 0);
link('Existing open ticket?', 'Create ticket', 1);
link('Update ticket', 'Build audit row');
link('Create ticket', 'Build audit row');
link('Build audit row', 'Append audit log');
link('Append audit log', 'Result');
link('Result', 'Respond');

// sticky notes for reviewers
const sticky = (name, pos, content, w = 520, h = 200) => node(name, 'n8n-nodes-base.stickyNote', 1, pos, { content, width: w, height: h });
sticky('Note: classify', [X(4) - 20, 40], '## 1. Classify + extract (LLM)\nGroq gpt-oss-20b, temperature 0, JSON mode. Output validated against `llm_output.schema.json` in code. Invalid -> one repair retry -> safe fallback (`other` + needs human). The email is passed as delimited untrusted data.', 760, 200);
sticky('Note: decide', [X(8) - 20, 40], '## 2. Policy engine (deterministic)\n`Decide` runs code/policy.js: order lookup (ID, else sender email), identity check, date maths from `received_at`, return/damage windows, protocol table, needs_human rules. The LLM cannot override it.', 500, 200);
sticky('Note: agent', [X(10) - 20, -10], '## 3. AI agent drafts the reply\nTools: `get_order` (identity bound to sender in code) and `search_faq` (FAQ sections only). Draft is fact-checked: every amount, date and link must come from the order/FAQ; no cure claims; no leaks. Fails -> one redraft with verified facts -> safe holding reply + human.', 760, 200);
sticky('Note: sheets', [X(15) - 20, -60], '## 4. Tickets (no duplicates) + audit log\nRead Tickets -> open ticket for same order? update it (append email id + note) : create TKT-###. Every email gets one Audit Log row. v1 runs write to the "(v1)" tabs.', 760, 200);

const wf = {
  name: store === 'memory' ? 'Kesar Support Copilot (dev, memory store)' : 'Kesar Support Copilot',
  id: store === 'memory' ? 'kesarDevMemory01' : 'kesarCopilot0001',
  active: false,
  settings: { executionOrder: 'v1', saveDataSuccessExecution: 'all', saveManualExecutions: true },
  nodes, connections, pinData: {}, meta: { templateCredsSetupCompleted: false },
};
if (store === 'memory') {
  const hook = nodes.find((n) => n.name === 'Email In (webhook)');
  hook.parameters.path = 'kesar-support-dev'; hook.webhookId = 'kesar-support-dev-webhook';
}
const out = path.join(__dirname, store === 'memory' ? 'dev_memory.json' : 'kesar_support_copilot.json');
fs.writeFileSync(out, JSON.stringify(wf, null, 2));
console.log(`wrote ${path.relative(ROOT, out)} (${nodes.length} nodes, store=${store})`);
