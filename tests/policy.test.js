// Unit tests for the deterministic layer. Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const P = require('../code/policy.js');

const data = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', f), 'utf8'));
const orders = data('orders.json').orders;
const emails = data('test_emails.json').emails;
const faq = fs.readFileSync(path.join(__dirname, '..', 'data', 'faq.md'), 'utf8');
const expected = JSON.parse(fs.readFileSync(path.join(__dirname, 'expected.json'), 'utf8'));
const byId = Object.fromEntries(emails.map((e) => [e.id, e]));

function idealCls(id) {
  const x = expected[id];
  return Object.assign({
    intent: x.intent, secondary_intent: null, order_id: P.findOrderIdInText(byId[id]),
    sentiment: 'neutral', language: 'en', confidence: 0.9, summary: 'test',
  }, x.cls);
}

test('schema validation: good, repaired and bad outputs', () => {
  const ok = P.validateClassification('```json\n{"intent":"order_status","secondary_intent":null,"order_id":"kc-1041","sentiment":"neutral","language":"en","confidence":0.9,"summary":"x"}\n```');
  assert.equal(ok.valid, true);
  assert.equal(ok.value.order_id, 'KC-1041');
  assert.equal(P.validateClassification('not json').valid, false);
  assert.equal(P.validateClassification('{"intent":"refund"}').valid, false);
  const badId = P.validateClassification({ intent: 'other', secondary_intent: null, order_id: 'KC-12', sentiment: 'neutral', language: 'en', confidence: 0.5, summary: 'x' });
  assert.equal(badId.valid, false);
  const longSummary = P.validateClassification({ intent: 'other', secondary_intent: null, order_id: null, sentiment: 'neutral', language: 'en', confidence: 0.5, summary: 'x'.repeat(201) });
  assert.equal(longSummary.valid, false);
});

test('fallback classification always needs a human and takes no action', () => {
  const d = P.decide({ email: byId.E01, cls: P.fallbackClassification(byId.E01), orders });
  assert.equal(d.needs_human, true);
  assert.equal(d.ticket, null);
  assert.ok(d.reasons.includes('classification_failed'));
});

test('order lookup by id, by sender email, and identity check', () => {
  assert.equal(P.lookupOrder(orders, 'KC-1041', 'ananya.rao@example.com').identity_ok, true);
  assert.equal(P.lookupOrder(orders, null, 'Vikram.Singh@example.com').order.order_id, 'KC-1044');
  const mismatch = P.lookupOrder(orders, 'KC-1046', 'arjun.nair@example.com');
  assert.equal(mismatch.found, true);
  assert.equal(mismatch.identity_ok, false);
  assert.equal(P.lookupOrder(orders, 'KC-1099', 'neha.kulkarni@example.com').reason, 'order_id_not_found');
  assert.equal(P.lookupOrder(orders, null, 'rahul.b@example.com').reason, 'no_order_for_sender');
});

test('get_order tool never leaks to a different sender and never exposes the address', () => {
  const leak = P.getOrderTool(orders, 'KC-1046', 'arjun.nair@example.com');
  assert.equal(leak.ok, false);
  assert.ok(!JSON.stringify(leak).includes('track.example.com'));
  const ok = P.getOrderTool(orders, 'KC-1041', 'ananya.rao@example.com');
  assert.equal(ok.ok, true);
  assert.equal(ok.order.shipping_address, undefined);
  assert.equal(ok.order.customer_email, undefined);
});

test('date maths uses received_at (IST), not the clock', () => {
  assert.equal(P.istDateString('2026-11-20T09:28:00+05:30'), '2026-11-20');
  assert.equal(P.istDateString('2026-11-19T20:00:00Z'), '2026-11-20'); // 01:30 IST next day
  const f = P.orderFacts(orders.find((o) => o.order_id === 'KC-1055'), '2026-11-20T12:05:00+05:30');
  assert.equal(f.days_since_delivery, 8);
  assert.equal(f.within_return_window, false);
});

test('protocol, ticket and needs_human for all 25 emails with an ideal classification', () => {
  for (const id of Object.keys(byId)) {
    const x = expected[id];
    const d = P.decide({ email: byId[id], cls: idealCls(id), orders });
    assert.equal(d.protocol, x.protocol, `${id} protocol`);
    assert.equal(d.needs_human, x.needs_human, `${id} needs_human (${d.reasons.join(',')})`);
    assert.equal(!!d.ticket, !!x.ticket, `${id} ticket needed`);
    if (x.priority) assert.equal(d.ticket.priority, x.priority, `${id} priority`);
    if (x.eligible !== undefined) assert.equal(d.eligibility.eligible, x.eligible, `${id} eligible`);
  }
});

test('escalation threshold: confidence below 0.75 needs a human, at 0.75 does not', () => {
  const low = P.decide({ email: byId.E01, cls: Object.assign(idealCls('E01'), { confidence: 0.74 }), orders });
  const atT = P.decide({ email: byId.E01, cls: Object.assign(idealCls('E01'), { confidence: 0.75 }), orders });
  assert.equal(low.needs_human, true);
  assert.equal(atT.needs_human, false);
});

test('prompt injection (E12) cannot remove the ticket, lower priority or approve a refund', () => {
  const d = P.decide({ email: byId.E12, cls: idealCls('E12'), orders });
  assert.ok(d.flags.injection.length > 0);
  assert.equal(d.ticket.priority, 'Medium');
  assert.equal(d.eligibility.eligible, false);
  // even if the model is fooled into "positive / other / high confidence", order-linked rules still apply
  const fooled = P.decide({ email: byId.E12, cls: Object.assign(idealCls('E12'), { item_condition: 'unopened', issue_type: 'changed_mind' }), orders });
  assert.equal(fooled.eligibility.eligible, false, 'still outside the 7-day window');
  assert.equal(fooled.needs_human, true);
});

test('model-invented order IDs are ignored', () => {
  const cls = Object.assign(idealCls('E10'), { order_id: 'KC-1050' }); // not in E10 text
  const d = P.decide({ email: byId.E10, cls, orders });
  assert.equal(d.order_id, 'KC-1044');
});

test('ticket dedupe: E21 updates the open E04 ticket; closed tickets are not reused', () => {
  const d4 = P.decide({ email: byId.E04, cls: idealCls('E04'), orders });
  const t4 = P.planTicket([], { email: byId.E04, cls: idealCls('E04'), decision: d4, nowIso: 'T1' });
  assert.equal(t4.op, 'create');
  assert.equal(t4.row.ticket_id, 'TKT-001');
  const d21 = P.decide({ email: byId.E21, cls: idealCls('E21'), orders });
  const t21 = P.planTicket([t4.row], { email: byId.E21, cls: idealCls('E21'), decision: d21, nowIso: 'T2' });
  assert.equal(t21.op, 'update');
  assert.equal(t21.row.ticket_id, 'TKT-001');
  assert.equal(t21.row.email_ids, 'E04, E21');
  assert.match(t21.row.notes, /E21/);
  // re-processing the same email does not duplicate the id
  assert.equal(P.planTicket([t21.row], { email: byId.E21, cls: idealCls('E21'), decision: d21 }).row.email_ids, 'E04, E21');
  const closed = Object.assign({}, t4.row, { status: 'Closed' });
  const t = P.planTicket([closed], { email: byId.E21, cls: idealCls('E21'), decision: d21 });
  assert.equal(t.op, 'create');
  assert.equal(t.row.ticket_id, 'TKT-002');
});

test('draft post-check catches invented amounts, dates, links, cure claims and privacy leaks', () => {
  const e = byId.E01;
  const d = P.decide({ email: e, cls: idealCls('E01'), orders });
  const of = P.safeOrderFacts(orders.find((o) => o.order_id === 'KC-1041'));
  const ctx = { decision: d, faqText: faq, orderFacts: of, email: e };
  const good = 'Hi Ananya,\n\nYour order KC-1041 has shipped with SwiftShip and should reach you by 21 Nov. Track it here: https://track.example.com/SS7781041.\n\nWarm regards,\nTeam Kesar';
  assert.deepEqual(P.checkDraft(good, ctx).problems, []);
  const bad = 'Hi Ananya, it arrives 24 Nov, track at https://fake.example/x. Refund of Rs 500 approved your refund.\nWarm regards,\nTeam Kesar';
  const r = P.checkDraft(bad, ctx);
  assert.equal(r.ok, false);
  assert.ok(r.problems.some((p) => p.includes('date')));
  assert.ok(r.problems.some((p) => p.includes('link')));
  assert.ok(r.problems.some((p) => p.includes('amount')));
  const med = P.checkDraft('Hi, our Kumkumadi oil will cure your eczema.\nWarm regards,\nTeam Kesar', ctx);
  assert.ok(med.problems.some((p) => p.includes('medical')));
  assert.equal(P.checkDraft('Our products are cosmetics and do not cure or treat conditions.\nWarm regards,\nTeam Kesar', ctx).ok, true);

  const e7 = byId.E07;
  const d7 = P.decide({ email: e7, cls: idealCls('E07'), orders });
  const leak = P.checkDraft('Hi Arjun, the order has shipped, tracking https://track.example.com/SS7781046\nWarm regards,\nTeam Kesar', { decision: d7, faqText: faq, orderFacts: null, email: e7 });
  assert.equal(leak.ok, false);
});

test('FAQ search returns grounded sections or an explicit not-covered message', () => {
  assert.match(P.searchFaq(faq, 'is saffron serum vegan and ok for oily skin'), /Saffron Glow Face Serum/);
  assert.match(P.searchFaq(faq, 'COD available Guwahati delivery time'), /North-East/);
  assert.match(P.searchFaq(faq, 'return policy refund'), /7 days of delivery/);
  assert.match(P.searchFaq(faq, 'eczema'), /dermatologist/);
  assert.match(P.searchFaq(faq, 'xyzzy quantum'), /NO MATCHING FAQ SECTION/);
});

test('E08 still escalates and stays High even if the model only says "negative"', () => {
  const d = P.decide({ email: byId.E08, cls: Object.assign(idealCls('E08'), { sentiment: 'negative' }), orders });
  assert.equal(d.needs_human, true);
  assert.equal(d.ticket.priority, 'High');
  assert.ok(d.reasons.some((r) => r.startsWith('public_or_legal_threat')));
});
