# Recoup

**An AI revenue recovery agent for PayPal merchants.**

Small businesses lose money they have already earned: invoices that go unpaid, subscription renewals that fail on an expired card, disputes that are lost because nobody responded in time. Recoup runs one agent across all three leaks. It finds the money, proposes the next best recovery action with a drafted customer message, and acts only within a mandate the merchant writes in plain rules. Everything it does lands in an audit ledger with the rule that allowed it.

Built for the PayPal AI Hackathon 2026 ("Build what's next with PayPal and AI").

## What it does

| Leak | Detected from | Agent actions |
|---|---|---|
| Unpaid invoices | PayPal Invoicing API (sync) and `INVOICING.INVOICE.PAID` webhook | friendly reminder, prompt-payment discount, instalment plan |
| Failed subscription renewals | `BILLING.SUBSCRIPTION.PAYMENT.FAILED` webhook | notify and retry, offer a pause instead of cancellation, request a new payment method |
| Disputes | PayPal Disputes API (sync) and `CUSTOMER.DISPUTE.*` webhooks | assemble and submit an evidence pack, message the buyer, or recommend accepting the claim when the evidence favours the buyer |

**The Mandate layer** is the part that makes an agent safe to let loose on money. Every proposed action gets one of three verdicts:

- **act**: within the mandate, the agent proceeds alone
- **ask**: outside the mandate, queued for one-click approval
- **refuse**: not allowed, logged and never executed

Rules cover amount limits, discount limits, when to start chasing, maximum customer contacts, quiet hours and which action types always need a human.

## PayPal technologies used

- REST OAuth 2.0 (client credentials)
- Invoicing API v2: list, create, send, remind, record payment
- Subscriptions API v1: get, suspend, activate, transactions
- Customer Disputes API v1: list, get, send message, provide evidence, accept claim
- Webhooks API v1: create webhook, verify signature, event handling
- Transaction Search API v1 (reporting)

All calls run against the PayPal sandbox.

## AI

The agent layer uses Claude (Anthropic) to choose the next action and draft the customer message for each case. Without an `ANTHROPIC_API_KEY` it falls back to a deterministic template agent, so the prototype runs anywhere. The mandate layer is deliberately not an LLM: it is a rules engine, so its verdicts are predictable and auditable.

## Run it locally

```bash
git clone https://github.com/dcontessa/paypal-ai-hackathon
cd paypal-ai-hackathon
npm install
cp .env.example .env     # add PayPal sandbox credentials; optional Anthropic key
npm start                # http://localhost:3000
```

`DEMO_MODE=true` (the default in `.env.example`) seeds seven demo cases so you can see the full flow without waiting for sandbox events. Click **Run agent**, then approve or decline the proposals that fall outside the mandate.

With PayPal credentials set you can also:

- **Sync from PayPal** to pull unpaid invoices and open disputes into cases
- **Create and send a real sandbox invoice** from the dashboard, then chase it
- **Register the webhook** with `POST /api/webhooks/register` once `PUBLIC_URL` is set, so paid invoices, failed renewals and dispute events flow in automatically

## Deploy on Render

A `render.yaml` is included. Create a new Blueprint from this repo, then set `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PUBLIC_URL` and (optionally) `ANTHROPIC_API_KEY` in the service's environment. Storage is a JSON file, so data resets on redeploy; swap `src/store.js` for a database for production.

## Project layout

```
server.js          Express app and API routes
src/paypal.js      PayPal REST client (sandbox)
src/agent.js       Claude agent with template fallback
src/mandate.js     Rules engine: act / ask / refuse
src/engine.js      Case intake, agent run, execution, recovery ledger, webhooks
src/store.js       JSON-file persistence
src/seed.js        Demo cases
public/index.html  Dashboard
```

## Business model

Recoup is priced on outcomes: a small monthly fee plus a percentage of revenue recovered. The merchant pays when Recoup earns its keep, and Recoup can bill its own customers through PayPal Subscriptions.

## Licence

MIT
