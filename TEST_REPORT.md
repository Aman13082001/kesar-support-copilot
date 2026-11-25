# Test Report — Kesar & Co. Support Copilot

**Candidate name:** Aman Kumar Sharma
**Platform used:** n8n 2.49.5 (self-hosted community edition)
**LLM(s) used:** Groq free tier: `openai/gpt-oss-20b` (classification, temperature 0, JSON mode) and `openai/gpt-oss-120b` (AI agent, temperature 0.2)

All numbers below come from real runs through the n8n workflow into the Google Sheet. The raw responses are in `results/v1.json`, `results/v2_run1.json` (first v2 run) and `results/v2.json` (final v2 run), and are scored by `scripts/run_eval.js` against `tests/expected.json`.

## 1. How I decided what "correct" means

Before running any model, I wrote the expected **intent, protocol, ticket (create/update/none) and needs_human** for every email in [tests/expected.json](tests/expected.json), using only `faq.md` and `orders.json`. An email counts as ✅ only if **all four** match. Judgment calls:
- Damaged, leaking, wrong or missing items are `complaint` (E08 and E23 also ask for a refund, which goes in `secondary_intent`), and they follow the damage protocol: 48 h window, photos required.
- E24 (a cancelled order, "what's going on?") is order status, with no ticket.
- E17 (influencer) gets a redirect to partnerships@ (FAQ §9). E06 (spam) and E25 (thanks) are log only.
- needs_human is expected for: the privacy mismatch (E07), the angry public threat (E08), the injection (E12), the GST request not covered by the FAQ (E13), the medical question (E20), and attached photos to verify (E21).

I also **read every draft** and judged its content separately (§2 notes, §5), because correct routing doesn't guarantee a correct reply.

## 2. Results per email

v1 = first prompts ([classify_v1](prompts/classify_v1.md), [agent_v1](prompts/agent_v1.md)) on 10 emails. v2 = final prompts plus the fact-checker fixes, on all 25.

| Email | Expected intent | Expected action | v1 intent | v1 action | v1 ✅/❌ | v2 intent | v2 action | v2 ✅/❌ | Notes |
|---|---|---|---|---|---|---|---|---|---|
| E01 | order_status | draft: shipped, ETA 21 Nov, tracking | other (fallback) | holding reply, needs human | ❌ | order_status | draft (status + tracking) | ✅ | v2 draft uses markdown `**bold**` (nit) |
| E02 | product_query | FAQ draft: oily OK, vegan | — | — | — | product_query | FAQ draft | ✅ | |
| E03 | return_refund | ticket + eligible return draft | other (fallback) | holding reply, no ticket | ❌ | return_refund | TKT-001 + draft | ✅ | Refund Rs 899 (shipping excluded), correct |
| E04 | complaint | ticket High + ask photos | complaint | ticket, safe holding reply | ❌ | complaint | TKT-002 + ask photos | ✅ | v1: no `issue_type`, so generic complaint protocol |
| E05 | order_status | Hinglish-style draft, ETA 23 Nov | other (fallback) | holding reply | ❌ | order_status | draft | ✅ | Final v2 draft came out in English (first v2 run was Hinglish) |
| E06 | other | log only | other (fallback) | **replied to spammer**, needs human | ❌ | other | log only | ✅ | |
| E07 | order_status | privacy-safe draft, needs human | other (fallback) | holding reply | ❌ | order_status | privacy draft, needs human | ✅ | ⚠ v2 draft invents "log in to your account" (§5) |
| E08 | complaint | ticket High + photos, needs human | other (fallback) | holding reply, **no ticket** | ❌ | complaint | TKT-003 High, needs human | ✅ | Threat caught by regex, not model sentiment |
| E09 | product_query | Hindi: 6–8 business days, COD OK, Rs 49 | — | — | — | product_query | Hindi FAQ draft | ✅ | |
| E10 | order_status | lookup by email → KC-1044 | — | — | — | order_status | draft | ✅ | |
| E11 | return_refund | ticket + eligible kit return | — | — | — | return_refund | TKT-004 + draft | ✅ | |
| E12 | return_refund | ticket, decline (8 days, used), needs human | other (fallback) | holding reply, **no ticket** | ❌ | return_refund | TKT-005 + decline, needs human | ✅ | Injection ignored; ticket created, priority Medium |
| E13 | other | holding reply, needs human | — | — | — | other | holding draft, needs human | ✅ | |
| E14 | complaint | ticket High + ask photos | — | — | — | complaint | TKT-006 + draft | ✅ | |
| E15 | order_status | out for delivery today, COD | — | — | — | order_status | draft | ✅ | |
| E16 | return_refund | ticket + decline | — | — | — | return_refund | TKT-007 + decline | ✅ | |
| E17 | other | redirect to partnerships@ | other (fallback) | holding/redirect, needs human | ❌ | other | redirect draft | ✅ | v2 says partnerships replies "within 24 business hours" (minor) |
| E18 | order_status | ask for order ID | — | — | — | order_status | ask for ID | ✅ | |
| E19 | return_refund | ticket + eligible COD return | — | — | — | return_refund | TKT-008 + draft | ✅ | |
| E20 | product_query | safe medical reply, needs human | — | — | — | product_query | safe reply, needs human | ✅ | |
| E21 | complaint | **update** E04's ticket, needs human | other (fallback) | no ticket update | ❌ | complaint | **updated TKT-002**, needs human | ✅ | Draft doesn't acknowledge the "replacement" preference (minor) |
| E22 | order_status | KC-1099 not found → ask | — | — | — | order_status | "can't find KC-1099" | ✅ | |
| E23 | complaint | ticket High + ask photos | — | — | — | complaint | TKT-009 + draft | ✅ | |
| E24 | order_status | cancelled, Rs 828 refund initiated | — | — | — | order_status | draft | ✅ | |
| E25 | other | log only | — | — | — | other | log only | ✅ | |

## 3. Summary

| Metric | Prompt v1 | Prompt v2 (final) |
|---|---|---|
| Emails run (*n*) | 10 | 25 |
| Intent accuracy (x / *n*) | 3 / 10 | 25 / 25 |
| Correct action (x / *n*), i.e. protocol + ticket + needs_human all correct | 0 / 10 | 25 / 25 |
| Valid JSON on first try (x / *n*) | 1 / 10 (9 fell back to safe default after retry) | 25 / 25 |
| Emails sent to "needs human" | 10 | 6 (all 6 expected) |
| Duplicate tickets | 0 (no tickets except E04) | 0 (9 tickets, E21 merged into TKT-002) |
| Drafts passing fact check first time | 1 / 10 | 23 / 23 drafted |
| Drafts I would send without edits (manual review) | — | 18 / 23 (4 minor edits: E01, E05, E17, E21; 1 invented process: E07) |
| Avg. tokens per email (measured from n8n logs) | — | 3,682 (classify 1,234 + agent 2,449) |
| Est. cost per email (paid list price) | — | $0.00067 (₹0.06); free tier used = ₹0 |

**First v2 run** (before the checker fix, `results/v2_run1.json`): also 25/25 on routing, but my manual review found 4 wrong drafts (E03 promised a "full refund"; E11 and E19 invented "pickup within 24 hours"; E21 said "24 hours" instead of business hours) and 1 checker false positive (E07). That led to change 3 below.

Unit tests: 13 tests for the policy layer + 1 regression test replaying the real run-1 drafts (`node --test tests/policy.test.js tests/replay_v2_drafts.test.js`), all passing.

## 4. What I changed from v1 to v2, and why

- **Change 1, classification prompt: exact enums, definitions, untrusted-input framing.** v1 didn't list the allowed values, so `gpt-oss-20b` returned `secondary_intent: ""`/`"none"` and invalid order IDs. 9/10 failed schema validation even after the repair retry. The fallback worked as designed (no wrong action, all sent to a human), but nothing useful happened. v2 lists every enum, defines each intent with tie-break rules (damage + refund = complaint), puts the email inside `<email>` tags marked as untrusted, and adds two short examples. Result: 25/25 valid on the first try.
- **Change 2, extra extracted fields that feed the policy engine:** `issue_type`, `item_condition`, `other_type`, `injection_suspected`. Without them (v1, E04), the engine can't tell a damage claim from a general complaint, a sealed return from a used one, or spam from a partnership request. v2 also gives the agent the policy engine's DECISION block, so it explains an outcome instead of inventing one.
- **Change 3, stronger fact checker plus deterministic risk rules (found by testing):**
  - the model labelled E08 "negative", so a regex now escalates public or legal threats and shouting;
  - E22 first asked for an ID the customer had already given, so the brief now says "KC-1099 not found";
  - Sheets append retries duplicated audit rows, so writes are no longer retried;
  - after run 1, the checker validates **timelines** against the FAQ, blocks "full refund" outside damage cases, and checks privacy leaks by **order values** instead of words like "tracking".

## 5. Failures I could not fix (be honest)

| Email | What goes wrong | Why I think it happens | What I would try next |
|---|---|---|---|
| E07 | Draft invents "log in to your Kesar & Co. account" (no accounts exist in the FAQ) | The checker validates facts (amounts, dates, links, timelines), not *processes*. The model fills a gap with a generic e-commerce habit. | A per-protocol whitelist of allowed next steps (for example, privacy mismatch = "write from the order email"), or an LLM-judge check against FAQ text. Mitigated today: E07 is always needs_human. |
| all | Confidence is 0.92–0.95 on almost every email, so the 0.75 threshold almost never fires | Self-reported LLM confidence is poorly calibrated | Rely on hard triggers (already done). Use log-prob or agreement between two classifications as the confidence. |
| E05 | Final v2 replied in English to a Hinglish email (run 1 replied in Hinglish) | Language matching is only a prompt instruction, and the model is non-deterministic at temperature 0.2 | Check the reply language in code and redraft if it doesn't match. |
| E21 | Doesn't acknowledge the customer's "replacement, not refund" choice | Preference isn't extracted as a field | Extract `resolution_preference` and add it to the brief and the ticket. |
| E01 | Markdown `**bold**` in a plain-text email | Model formatting habit | Strip markdown in Finalize. |
| — | Ticket dedupe has a race condition if two emails for the same order arrive at the same time | Read-then-write on Google Sheets | A real ticket store with a unique open-ticket-per-order constraint. |
| — | The 48 h damage window uses calendar days, because orders only record a delivery date | Data limitation | Use the courier's delivery timestamp. |
