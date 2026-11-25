# Kesar & Co. Support Copilot — Aman Kumar Sharma

## 1. Summary

- **What I built:** an n8n workflow that reads each support email, classifies it with an LLM, and runs a fixed business protocol in code to pick the action. An AI agent with `get_order` and `search_faq` tools drafts the reply, and a fact-checker rejects any draft that states something the order data or FAQ doesn't support. Returns and complaints become de-duplicated tickets, and every email is logged to Google Sheets.
- **Main design choice:** the LLM understands the email and writes the words. It never makes the business decision. Privacy, return eligibility, the 48-hour damage window, ticket creation, priority and `needs_human` are all decided by plain, unit-tested JavaScript ([code/policy.js](code/policy.js)) that the model's output can't override.
- **Platform and LLM:** n8n 2.49.5 self-hosted (community edition, `npm`). Groq free tier: `openai/gpt-oss-20b` for classification and `openai/gpt-oss-120b` for the agent. Cost to run: ₹0.
- **Time spent:** ~6 hours over the assignment window (setup ~1 h, build + testing ~4 h, write-up ~1 h)
- **What works and what doesn't:** see [TEST_REPORT.md](TEST_REPORT.md), which has real results for all 25 emails (v2) and 10 emails (v1). Known weak spots are listed honestly in §5 of that report.

**Google Sheet (view only):** https://docs.google.com/spreadsheets/d/1lYsqXMJNEupvZPDPJjC1DhRqJhimUwoSMp5ue7_eKro/edit
Tabs: `Audit Log`, `Tickets` (v2, final) · `Audit Log (v1)`, `Tickets (v1)` (earlier version).

**Demo video:** _will be shared by reply to the invitation email_

## 2. Architecture

![workflow](./screenshots/workflow.png)

```
Webhook ─► Prepare ─► Get orders ─► Get FAQ ─► Classify (LLM, JSON mode) ─► Validate JSON ─► valid? ──no──► Repair (LLM retry) ─► Validate / fallback
                                                                                              │yes                                         │
                                                                                              ▼                                            ▼
                                                                                     Decide (policy engine, code) ◄────────────────────────┘
                                                                                              │
                                                                                     Route by protocol ──log_only──────────────────────┐
                                                                                              │                                         │
                                                                     AI agent (gpt-oss-120b) + tools get_order / search_faq             │
                                                                                              │                                         │
                                                                     Check draft (fact checker) ─fail─► Redraft with verified facts      │
                                                                                              │                     │                   │
                                                                                              ▼                     ▼                   ▼
                                                                                           Finalize (draft, needs_human) ◄──────────────┘
                                                                                              │
                                                       Ticket needed? ─yes─► Read Tickets ─► Plan ticket ─► open ticket for order? update : create
                                                                                              │
                                                                                     Build audit row ─► Append Audit Log ─► Respond
```

| Step / node | What it does | Why I designed it this way |
|---|---|---|
| **Email In (webhook)** | `POST /webhook/kesar-support`, one email per request. `?v=v1` selects the v1 prompts and v1 tabs. | This is closest to real life, and it works with the provided `send_test_emails.py`. |
| **Prepare** | Validates the request shape and renders the classification prompt. The email goes inside `<email>` tags marked as untrusted data. | Keeps prompt-injection text out of the instruction channel. |
| **Get orders / Get FAQ** | HTTP GET of the repo's `orders.json` and `faq.md`. | Treated as a read-only order API, as the brief suggests. Both are fetched fresh every run. |
| **Classify (LLM)** | Groq `gpt-oss-20b`, temperature 0, `response_format: json_object`. Retries 5× on 429/5xx. | One call does both classification and extraction. The cheap model is enough for this step (see TEST_REPORT). |
| **Validate JSON → Repair → Fallback** | A hand-written validator for `llm_output.schema.json`. If the output is invalid, the model gets one repair attempt with the error list. If that also fails, the email falls back to `intent: other` + `needs_human`. | Bad model output can never drive an action. Extra fields (`issue_type`, `item_condition`, `other_type`, `injection_suspected`) are allowed by the schema and feed the policy engine. |
| **Decide (policy engine)** | Runs `decide()` from [code/policy.js](code/policy.js): order lookup by ID (else by sender email), identity check, date maths from `received_at`, the return window (7 days, unopened), the damage window (48 h + photos), the protocol table, priority, and the `needs_human` rules. | All hard rules live in code, as the brief recommends ("a model can be talked out of them"). It's covered by 13 unit tests. An order ID the model invents (one not literally present in the email) is ignored. |
| **Route by protocol** | Five visible branches: order status / product query / return-or-damage / clarify-privacy-escalate / log only. | Makes each business path visible on the canvas. |
| **Draft reply (AI agent)** | n8n Tools Agent on `gpt-oss-120b`. Tools: **`get_order`** (Code tool; the sender's email is bound from the webhook *in code*, so the model can't fetch someone else's order, and the address and email are never returned) and **`search_faq`** (splits faq.md by heading and returns the top 2 sections verbatim, or "not covered"). The system prompt includes the policy engine's DECISION block, which is final. | The agent decides which tools to call, but it can't change the outcome. |
| **Check draft → Redraft** | Every ₹ amount, date, link and email address in the draft must appear in this customer's order data or the FAQ. It also rejects cure/treat claims, "refund approved" promises, privacy leaks to a non-matching sender, emoji, and a missing sign-off. If the check fails, one redraft is made with the verified facts pasted in. If that fails too, a safe holding reply is used and `needs_human` is set. | A deterministic net against hallucination. In testing it caught real problems (see TEST_REPORT). |
| **Tickets** | Read the Tickets tab, look for an **open** ticket with the same `order_id`, then **update** it (append the email ID and a note, keep the higher priority) or **create** `TKT-###`. | This is how dedupe works. E21 updates E04's ticket. |
| **Audit Log** | One row per email with the template's 18 columns. `notes` holds the protocol, eligibility, flags, fact-check result and classification tokens. | It's the reviewer's single place to see why each decision was made. |

## 3. Setup — how someone else can run this

Needs Node.js 24+, a free Groq key and a free Google Cloud service account. No paid plan or card is required.

1. **Credentials (no keys are in this repo):**
   - Groq: https://console.groq.com → API Keys → Create (free, no card).
   - Google: Cloud Console → new project → enable **Google Sheets API** → IAM → Service accounts → Create → Keys → Add key (JSON). Create a Google Sheet and share it as **Editor** with the service account's `client_email`.
   - `cp .env.example .env` and fill in `GROQ_API_KEY` and `SHEET_ID`. Put the JSON key at `.secrets/google-sa.json`. Both paths are gitignored.
2. **Install and start n8n** (in a folder whose path has no `&`, which breaks npm on Windows):
   ```bash
   mkdir n8n-runtime && cd n8n-runtime && npm init -y && npm install n8n@2.49.5
   export N8N_USER_FOLDER=$PWD/data
   ```
3. **Prepare the sheet, load credentials, build and import the workflow** (from the repo root, with n8n stopped):
   ```bash
   node scripts/setup_sheet.js                      # creates the 4 tabs + header rows
   N8N_HOME=/path/to/n8n-runtime node scripts/n8n_import_creds.js
   node workflow/build.js                           # regenerates workflow/kesar_support_copilot.json from code/ + prompts/
   N8N_HOME=/path/to/n8n-runtime bash scripts/n8n_deploy.sh workflow/kesar_support_copilot.json
   cd /path/to/n8n-runtime && npx n8n start         # editor at http://localhost:5678
   ```
   Alternatively, import `workflow/kesar_support_copilot.json` in the n8n UI, create the two credentials *Groq (free tier)* and *Google Sheets (service account)*, set the sheet ID in the Google Sheets nodes, and activate.
4. **Run the 25 test emails:**
   ```bash
   node scripts/run_eval.js --version v2 --delay 30000              # all 25, scored against tests/expected.json
   node scripts/run_eval.js --version v1 --only E01,E03,... --delay 30000
   python scripts/send_test_emails.py --url http://localhost:5678/webhook/kesar-support   # the provided sender also works
   node scripts/setup_sheet.js --reset v2                           # clear rows before a re-run
   node --test tests/*.test.js                                            # unit tests for the policy layer
   ```
   Keep about 30 s between emails. Groq's free tier allows 8K tokens/minute per model.

## 4. Prompts

All prompts are in [prompts/](prompts/) and are inlined into the workflow by `build.js`.

| Prompt | Model and settings |
|---|---|
| [classify_v2.md](prompts/classify_v2.md) (final) | `openai/gpt-oss-20b`, temperature 0, `reasoning_effort: low`, JSON mode, max 1,200 tokens |
| [agent_v2.md](prompts/agent_v2.md) (final) | `openai/gpt-oss-120b`, temperature 0.2, max 1,500 tokens, max 6 agent iterations |
| [classify_v1.md](prompts/classify_v1.md), [agent_v1.md](prompts/agent_v1.md) | Same models. The naive first version, kept for the v1 comparison. |

## 5. Key decisions and assumptions

- **Low confidence:** `needs_human` if confidence < **0.75**, *or* on any hard trigger: angry sentiment, public or legal threat or shouting (regex, because in testing the model called E08 only "negative"), prompt injection (regex + model flag), medical wording, sender ≠ order owner, attached photos to verify, GST/admin requests the FAQ doesn't cover, classification fallback, or a draft that failed the fact check twice. The model reported 0.92–0.95 confidence on almost every email, so **confidence alone is a weak signal**, and the hard triggers do most of the work. I picked 0.75 so that "two plausible intents" (the prompt asks for 0.6–0.8 there) goes to a human.
- **Duplicate tickets:** before creating, read the Tickets tab and look for a row with the same `order_id` whose status isn't `Closed`. If one exists, update it: add the email ID to `email_ids`, append a note, and keep the higher priority. Sheets **writes are never auto-retried**, because a retry duplicated audit rows in testing. Only reads retry.
- **Right customer only:** `get_order` compares the webhook sender with `customer_email` in code. If they don't match, the tool returns a PRIVACY error and no data. The policy engine switches to the `privacy_mismatch` protocol (no ticket, `needs_human`), and the fact checker rejects any draft to a non-matching sender that mentions tracking or shipping details. The shipping address and customer email are never given to the model.
- **Grounded in the FAQ:** `search_faq` returns FAQ text verbatim, or "not covered", in which case the agent must emit `[NEEDS_HUMAN]`. The fact checker only allows ₹ amounts that appear in the FAQ or this order, and only dates from this order or today.
- **Dates:** "today" is the IST date of each email's `received_at`. The 48-hour damage window uses calendar days (≤ 2), because orders only record a delivery *date*, not a time.
- **Other assumptions:** partnership enquiries get a short redirect to `partnerships@` (FAQ §9). Spam and thank-you notes are log only. E24 (a cancelled order, "what's going on?") is treated as order status, not a complaint. Returns get Medium priority; damage, complaints and public threats get High.

## 6. Scaling to 1,000 emails/day

- **What breaks first:** Groq free-tier limits of 8K tokens/min and 200K tokens/day per model. One email uses ~3.7K tokens on average (measured), so 1,000/day (~3.7M tokens) needs the paid tier (cost below).
- **Queueing:** put a queue (n8n queue mode with Redis, or a mailbox poller) in front of the webhook so bursts don't hit rate limits, and process with a small number of concurrent workers.
- **Sheets:** reading the whole Tickets tab per email doesn't scale. Move tickets to a real store (Postgres, or a helpdesk like Freshdesk) with an index on `order_id` and a unique "open ticket per order" constraint. That also removes the race condition between two emails about the same order.
- **Cost:** cache the FAQ in the system prompt (Groq prompt caching halves input cost), and skip the agent for log-only emails (already done).
- **Monitoring:** alert on the fallback rate, the fact-check failure rate, the `needs_human` rate and 429s. Review a random sample of drafts weekly.

## 7. Product-thinking questions

**1. Auto-send vs. draft.**
Auto-send only *read-only, verified* replies where the code already proved every fact: order status for a matched sender (status, ETA and tracking all come from the order record), and FAQ answers that passed the fact check with no medical or injection flag. Everything that moves money or makes a promise stays a draft: returns, refunds, damage claims, complaints, privacy mismatches, angry customers, and anything the FAQ doesn't cover. The confidence threshold (0.75) is a backstop, not the main gate. In my runs the model said 0.92–0.95 for nearly everything, so I'd gate auto-send on **protocol + passed fact check + no risk flags**, and require confidence ≥ 0.9 on top. I'd start in shadow mode, where drafts are compared with what the human actually sent, before turning auto-send on.

**2. Cost.**
These are *measured* averages over the final v2 run of 25 emails, read from n8n's execution logs (`scripts/token_usage.js`), priced at Groq's paid list prices (gpt-oss-20b $0.075 in / $0.30 out per 1M tokens; gpt-oss-120b $0.15 / $0.60). The free tier I used cost ₹0.
- Classify (20b): 1,092 in + 142 out → 1,092×0.075/1M + 142×0.30/1M ≈ **$0.00012**
- Agent (120b, ~2 calls; zero for log-only emails): 2,046 in + 403 out → 2,046×0.15/1M + 403×0.60/1M ≈ **$0.00055**
- **Total ≈ $0.00067 per email (≈ ₹0.06)**, 3,682 tokens.
- 1,000/day × 30 = 30,000 emails/month → **≈ $20/month (≈ ₹1,700)**. Add ~30% for redrafts, retries and longer real emails: **≈ $26/month**. That's negligible next to one support person's time. Groq's free tier (200K tokens/day per model) covers only about 50–80 emails/day, so production needs the paid tier.

**3. Success metric.**
**Draft acceptance rate**: the share of drafts a human sends with no or only minor edits, broken down by protocol. It captures correctness, tone and grounding in one number, and it's easy to log ("sent as-is / edited / rewritten"). Week-1 target: ≥ 70% for order status and FAQ answers. I'd switch it off (back to manual) after **any** privacy leak or invented fact reaching a customer, or if acceptance stays below 40% for a protocol, since then the copilot costs more time than it saves.

**4. Failure experience.**
Because everything is a draft, the usual failure is a human seeing a bad draft, not the customer. When a wrong reply does go out, the customer gets a wrong ETA, a refusal they didn't deserve, or a generic holding reply. Limits on the damage: (1) the fact checker blocks invented amounts, dates and links; (2) the copilot never approves refunds or closes tickets; (3) uncertain cases get a safe holding reply ("a team member will follow up within 24 business hours") instead of a guess; (4) every reply is traceable in the audit log (protocol, flags, checker result), so a mistake can be found and the customer contacted quickly; (5) policy is code, so a fix applies to every future email at once.

**5. Don't automate.**
**Approving refunds and judging damage claims from photos.** They move money, depend on judging evidence (is the jar really cracked? is this the same customer's third claim?), and are where fraud would concentrate. The copilot gathers the facts, drafts the message and opens the ticket, but a person decides. The other one is replying to customers who threaten public posts or legal action: a calm human reply protects the brand better than any template.

## 8. How I used AI tools

I used **Claude (Claude Code in VS Code)** as a pair programmer throughout: reading the brief and data, proposing the architecture, writing `policy.js`, the tests, the n8n build script and the prompts, and debugging (the npm `&` path issue, the duplicated Sheets appends, and checking n8n's node parameter schemas against the installed version). Where I relied on my own judgment:
- I wrote the **expected outcome for all 25 emails before running anything** ([tests/expected.json](tests/expected.json)), so the scoring couldn't drift toward what the model produced.
- I chose to put every business rule in code instead of the prompt, chose which cases escalate, and made the judgment calls (E17 redirect, E24 as order status, the 48 h interpretation).
- I reviewed every draft in the results, and I report the failures honestly in TEST_REPORT.

## 9. If I had one more week

- Shadow-mode evaluation against real human replies, plus a draft-acceptance dashboard.
- Move tickets to a proper store with a unique open-ticket-per-order constraint, and connect a real mailbox (Gmail trigger) instead of the webhook.
- Track the agent's token usage per email in the audit log (currently only the classification tokens are logged).
- A small embedding-based FAQ search for paraphrased questions, while keeping the "not covered → human" rule.
- More test emails per edge case (several orders per customer, repeated damage claims, more Hindi), and a regression run in CI for every prompt change.
