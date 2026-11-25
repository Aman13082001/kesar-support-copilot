// Regression: replay the REAL drafts from the first v2 run through the current fact checker.
// After reviewing them by hand, E03 (full refund on a change-of-mind return), E11, E19, E21
// ("within 24 hours", invented) are wrong and must now be caught; all others must still pass,
// including E07's correct privacy refusal that the old word-list rule rejected.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../code/policy.js');
const D = (f) => path.join(__dirname, '..', f);
const orders = JSON.parse(fs.readFileSync(D('data/orders.json'), 'utf8')).orders;
const emails = JSON.parse(fs.readFileSync(D('data/test_emails.json'), 'utf8')).emails;
const faq = fs.readFileSync(D('data/faq.md'), 'utf8');
const exp = JSON.parse(fs.readFileSync(D('tests/expected.json'), 'utf8'));
const drafts = JSON.parse(fs.readFileSync(D('tests/fixtures/v2_run1_drafts.json'), 'utf8'));
const SHOULD_FAIL = ['E03', 'E11', 'E19', 'E21'];

test('fact checker verdicts on the real first-run v2 drafts', () => {
  for (const [id, draft] of Object.entries(drafts)) {
    if (!draft) continue;
    const eid = id.slice(0, 3);
    const e = emails.find((x) => x.id === eid);
    const cls = Object.assign({ intent: exp[eid].intent, secondary_intent: null, order_id: P.findOrderIdInText(e), sentiment: 'neutral', language: 'en', confidence: 0.9, summary: 'x' }, exp[eid].cls);
    const d = P.decide({ email: e, cls, orders });
    const o = d.identity_ok && d.order_id ? orders.find((x) => x.order_id === d.order_id) : null;
    const c = P.checkDraft(draft, { decision: d, faqText: faq, orderFacts: o ? P.safeOrderFacts(o) : null, email: e });
    assert.equal(c.ok, !SHOULD_FAIL.includes(id), `${id}: ${c.problems.join(' / ')}`);
  }
});
