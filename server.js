import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { store } from "./src/store.js";
import * as paypal from "./src/paypal.js";
import * as engine from "./src/engine.js";
import { describeRules } from "./src/mandate.js";
import { seedDemo } from "./src/seed.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(err);
  res.status(500).json({ error: err.message });
});

// ---------- Read ----------

app.get("/api/state", (req, res) => {
  const s = store.get();
  res.json({
    merchant: s.merchant,
    rules: s.rules,
    rulesText: describeRules(s.rules),
    totals: store.totals(),
    cases: s.cases,
    actions: s.actions.slice(0, 100),
    ledger: s.ledger,
    events: s.events || [],
    paypalConfigured: paypal.configured(),
    agent: process.env.ANTHROPIC_API_KEY ? "claude" : "template",
    webhookId: s.webhookId,
  });
});

// ---------- Rules ----------

app.put("/api/rules", (req, res) => {
  const s = store.get();
  s.rules = { ...s.rules, ...req.body };
  store.save();
  res.json({ rules: s.rules, rulesText: describeRules(s.rules) });
});

app.put("/api/merchant", (req, res) => {
  const s = store.get();
  s.merchant = { ...s.merchant, ...req.body };
  store.save();
  res.json(s.merchant);
});

// ---------- Agent ----------

app.post("/api/sync", wrap(async (req, res) => res.json(await engine.syncFromPayPal())));
app.post("/api/run", wrap(async (req, res) => res.json({ actions: await engine.runAgent({ caseId: req.body?.caseId }) })));
app.post("/api/actions/:id/approve", wrap(async (req, res) => res.json(await engine.approve(req.params.id, req.body || {}))));
app.post("/api/actions/:id/decline", (req, res) => res.json(engine.decline(req.params.id, req.body?.note)));

// ---------- Cases ----------

app.post("/api/cases", (req, res) => res.json(engine.openCase({ ...req.body, source: "manual" })));

// Create a real sandbox invoice and open a case for it (the live demo path)
app.post("/api/cases/invoice", wrap(async (req, res) => {
  if (!paypal.configured()) return res.status(400).json({ error: "PayPal credentials not set" });
  const s = store.get();
  const { recipientEmail, recipientName, amount, description, dueDate } = req.body;
  const inv = await paypal.createInvoice({
    recipientEmail, recipientName, amount, currency: s.merchant.currency, description, dueDate,
    invoiceNumber: `RC-${Date.now().toString(36).toUpperCase()}`,
  });
  await paypal.sendInvoice(inv.id, { subject: `Invoice ${inv.detail.invoice_number} from ${s.merchant.name}` });
  const due = inv.detail?.payment_term?.due_date;
  const kase = engine.openCase({
    type: "invoice", ref: inv.detail.invoice_number, paypalId: inv.id,
    customerName: recipientName, customerEmail: recipientEmail,
    amount: inv.amount?.value ?? amount, currency: s.merchant.currency, dueDate: due,
    customerFirstName: (recipientName || "").split(" ")[0],
    daysOverdue: due ? Math.max(0, Math.floor((Date.now() - new Date(due)) / 86400_000)) : 0,
    description, source: "paypal-create",
  });
  res.json({ invoice: { id: inv.id, number: inv.detail.invoice_number, status: inv.status }, case: kase });
}));

// Mark a case as recovered. With PayPal configured and an invoice id, records the payment on the
// sandbox invoice as well (which also fires INVOICING.INVOICE.PAID if the webhook is registered).
app.post("/api/cases/:id/recovered", wrap(async (req, res) => {
  const s = store.get();
  const kase = s.cases.find((c) => c.id === req.params.id);
  if (!kase) return res.status(404).json({ error: "case not found" });
  const amount = req.body?.amount ?? kase.amount;
  let viaDetail = req.body?.via || "payment received";
  if (paypal.configured() && kase.type === "invoice" && kase.paypalId) {
    try {
      await paypal.recordInvoicePayment(kase.paypalId, { amount, currency: kase.currency, note: "Recorded by Recoup" });
      viaDetail = "invoice paid (recorded on PayPal)";
    } catch (err) {
      console.warn("Could not record payment on PayPal:", err.message);
    }
  }
  res.json(engine.recordRecovery(kase, { amount, via: viaDetail, evidence: req.body?.evidence || "manual" }));
}));

app.post("/api/cases/:id/close", (req, res) => res.json(engine.closeCase(req.params.id, req.body?.outcome || "closed", req.body?.detail || "closed by merchant")));

// ---------- Simulations for the demo ----------

app.post("/api/simulate/renewal-failed", (req, res) => {
  const kase = engine.openCase({
    type: "renewal", ref: `I-SIM${Date.now().toString(36).toUpperCase()}`,
    planName: req.body?.planName || "Pro plan (monthly)", customerName: req.body?.customerName || "Nadia",
    customerEmail: req.body?.customerEmail || "nadia@example.com",
    amount: req.body?.amount || 79, currency: store.get().merchant.currency, source: "simulated webhook",
  });
  res.json(kase);
});

app.post("/api/simulate/dispute", (req, res) => {
  const kase = engine.openCase({
    type: "dispute", ref: `PP-D-SIM${Date.now().toString(36).toUpperCase()}`, reason: req.body?.reason || "ITEM_NOT_RECEIVED",
    orderRef: req.body?.orderRef || "ORD-9001", customerName: req.body?.customerName || "Wei",
    amount: req.body?.amount || 150, currency: store.get().merchant.currency,
    trackingNumber: req.body?.trackingNumber, deliveryConfirmed: Boolean(req.body?.trackingNumber),
    respondBy: new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10), source: "simulated webhook",
  });
  res.json(kase);
});

app.post("/api/demo/reset", (req, res) => {
  store.reset();
  res.json(seedDemo());
});

// ---------- Webhooks ----------

app.post("/api/webhooks/register", wrap(async (req, res) => {
  const url = req.body?.publicUrl || process.env.PUBLIC_URL;
  if (!url) return res.status(400).json({ error: "PUBLIC_URL not set" });
  const hook = await paypal.ensureWebhook(url);
  const s = store.get();
  s.webhookId = hook.id;
  store.save();
  res.json(hook);
}));

app.post("/webhooks/paypal", wrap(async (req, res) => {
  const s = store.get();
  if (s.webhookId && paypal.configured()) {
    try {
      const v = await paypal.verifyWebhookSignature(req.headers, req.body, s.webhookId);
      if (v.verification_status !== "SUCCESS") return res.status(400).json({ error: "signature verification failed" });
    } catch (err) {
      console.warn("Webhook verification error:", err.message);
    }
  }
  await engine.handleWebhook(req.body);
  res.json({ ok: true });
}));

// ---------- Boot ----------

const PORT = process.env.PORT || 3000;
if (process.env.DEMO_MODE === "true") seedDemo();
app.listen(PORT, () => {
  console.log(`Recoup running on http://localhost:${PORT}`);
  console.log(`PayPal: ${paypal.configured() ? "sandbox credentials loaded" : "not configured (simulated mode)"}`);
  console.log(`Agent: ${process.env.ANTHROPIC_API_KEY ? "Claude" : "template agent"}`);
});
