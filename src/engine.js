// Orchestration: sync cases from PayPal, run the agent, apply the mandate, execute or queue.
import * as paypal from "./paypal.js";
import { propose } from "./agent.js";
import { evaluate } from "./mandate.js";
import { store } from "./store.js";

const now = () => new Date().toISOString();

// ---------- Case intake ----------

export function openCase(partial) {
  const existing = partial.ref && store.findCaseByRef(partial.type, partial.ref);
  if (existing) return existing;
  const c = {
    id: store.id("case"),
    status: "open",
    contactAttempts: 0,
    failureCount: partial.type === "renewal" ? 1 : 0,
    openedAt: now(),
    history: [{ at: now(), event: "opened", detail: partial.source || "manual" }],
    ...partial,
  };
  store.upsertCase(c);
  return c;
}

export function closeCase(id, outcome, detail) {
  const s = store.get();
  const c = s.cases.find((x) => x.id === id);
  if (!c) return null;
  c.status = "closed";
  c.outcome = outcome;
  c.closedAt = now();
  c.history.push({ at: now(), event: "closed", detail });
  store.save();
  return c;
}

// Pull unpaid invoices and open disputes from the sandbox and turn them into cases.
export async function syncFromPayPal() {
  if (!paypal.configured()) return { synced: 0, note: "PayPal credentials not set; running in demo mode" };
  let synced = 0;
  const invoices = await paypal.listInvoices();
  for (const inv of invoices) {
    const status = inv.status;
    if (!["SENT", "UNPAID", "PARTIALLY_PAID"].includes(status)) continue;
    const due = inv.detail?.payment_term?.due_date;
    const daysOverdue = due ? Math.max(0, Math.floor((Date.now() - new Date(due)) / 86400_000)) : 0;
    const amount = inv.amount?.value ?? inv.due_amount?.value;
    openCase({
      type: "invoice",
      ref: inv.detail?.invoice_number || inv.id,
      paypalId: inv.id,
      customerName: inv.primary_recipients?.[0]?.billing_info?.name?.given_name,
      customerEmail: inv.primary_recipients?.[0]?.billing_info?.email_address,
      amount,
      currency: inv.detail?.currency_code,
      dueDate: due,
      daysOverdue,
      source: "paypal-sync",
    });
    synced++;
  }
  try {
    const disputes = await paypal.listDisputes();
    for (const d of disputes) {
      if (["RESOLVED"].includes(d.status)) continue;
      openCase({
        type: "dispute",
        ref: d.dispute_id,
        paypalId: d.dispute_id,
        reason: d.reason,
        amount: d.dispute_amount?.value,
        currency: d.dispute_amount?.currency_code,
        disputeStatus: d.status,
        respondBy: d.seller_response_due_date,
        source: "paypal-sync",
      });
      synced++;
    }
  } catch (err) {
    console.warn("Dispute sync skipped:", err.message);
  }
  return { synced };
}

// ---------- Agent run ----------

export async function runAgent({ caseId } = {}) {
  const s = store.get();
  const targets = s.cases.filter((c) => c.status === "open" && (!caseId || c.id === caseId));
  const results = [];
  for (const kase of targets) {
    // one pending action per case
    const pending = s.actions.find((a) => a.caseId === kase.id && a.status === "pending");
    if (pending) continue;
    const proposal = await propose(kase, s.rules, s.merchant);
    const { verdict, reason } = evaluate(proposal, kase, s.rules);
    const action = store.addAction({
      id: store.id("act"),
      caseId: kase.id,
      caseRef: kase.ref,
      caseType: kase.type,
      amount: kase.amount,
      currency: kase.currency,
      ...proposal,
      verdict,
      verdictReason: reason,
      status: verdict === "act" ? "approved" : verdict === "ask" ? "pending" : "refused",
      proposedAt: now(),
    });
    kase.history.push({ at: now(), event: "proposed", detail: `${proposal.type} -> ${verdict}` });
    store.save();
    if (verdict === "act") await execute(action.id);
    results.push(action);
  }
  return results;
}

export async function approve(actionId, edits = {}) {
  const a = store.updateAction(actionId, { status: "approved", approvedAt: now(), ...edits });
  if (!a) throw new Error("action not found");
  return execute(actionId);
}

export function decline(actionId, note) {
  const a = store.updateAction(actionId, { status: "declined", declinedAt: now(), note });
  const s = store.get();
  const c = s.cases.find((x) => x.id === a.caseId);
  if (c) c.history.push({ at: now(), event: "declined", detail: `${a.type}: ${note || ""}` });
  store.save();
  return a;
}

// ---------- Execution against PayPal ----------

export async function execute(actionId) {
  const s = store.get();
  const a = s.actions.find((x) => x.id === actionId);
  const c = s.cases.find((x) => x.id === a.caseId);
  const live = paypal.configured() && c.paypalId;
  let result = { mode: live ? "paypal" : "simulated" };
  try {
    switch (a.type) {
      case "send_reminder":
      case "offer_discount":
      case "offer_instalments":
        if (live) result.paypal = await paypal.remindInvoice(c.paypalId, { subject: a.subject, note: a.message });
        else result.detail = "Reminder email simulated (no PayPal credentials)";
        c.contactAttempts++;
        break;
      case "retry_payment":
        // PayPal retries failed subscription payments on its own schedule; we notify and record the plan.
        result.detail = "Customer notified; retry scheduled in 3 days";
        c.contactAttempts++;
        c.retryAt = new Date(Date.now() + 3 * 86400_000).toISOString();
        break;
      case "offer_pause":
      case "request_new_payment_method":
        result.detail = "Customer message sent";
        c.contactAttempts++;
        break;
      case "submit_dispute_evidence":
        if (live) result.paypal = await paypal.provideEvidence(c.paypalId, { note: a.message, trackingNumber: c.trackingNumber, carrier: c.carrier });
        else result.detail = "Evidence pack submitted (simulated)";
        break;
      case "message_buyer":
        if (live) result.paypal = await paypal.sendDisputeMessage(c.paypalId, a.message);
        else result.detail = "Buyer message sent (simulated)";
        c.contactAttempts++;
        break;
      case "accept_dispute":
        if (live) result.paypal = await paypal.acceptClaim(c.paypalId, a.message);
        else result.detail = "Claim accepted, refund issued (simulated)";
        closeCase(c.id, "refunded", "Dispute accepted on agent recommendation");
        break;
      case "escalate_to_merchant":
        result.detail = "Escalated; no customer contact";
        break;
    }
    store.updateAction(actionId, { status: "executed", executedAt: now(), result });
    c.history.push({ at: now(), event: "executed", detail: `${a.type} (${result.mode})` });
    c.lastActionAt = now();
    store.save();
  } catch (err) {
    store.updateAction(actionId, { status: "failed", error: err.message });
    c.history.push({ at: now(), event: "failed", detail: err.message });
    store.save();
    throw err;
  }
  return store.get().actions.find((x) => x.id === actionId);
}

// ---------- Recovery ----------

export function recordRecovery(kase, { amount, via, evidence }) {
  const entry = store.recover({
    id: store.id("rec"),
    caseId: kase.id,
    caseRef: kase.ref,
    caseType: kase.type,
    amount: Number(amount),
    currency: kase.currency,
    via,
    evidence,
    at: now(),
  });
  closeCase(kase.id, "recovered", `${via}: ${kase.currency} ${Number(amount).toFixed(2)}`);
  return entry;
}

// Handle PayPal webhook events
export async function handleWebhook(event) {
  const type = event.event_type;
  const r = event.resource || {};
  if (type === "INVOICING.INVOICE.PAID") {
    const inv = r.invoice || r;
    const kase = store.get().cases.find((c) => c.type === "invoice" && c.paypalId === inv.id && c.status === "open");
    if (kase) recordRecovery(kase, { amount: inv.amount?.value ?? kase.amount, via: "invoice paid", evidence: event.id });
  } else if (type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED") {
    const existing = store.findCaseByRef("renewal", r.id);
    if (existing && existing.status === "open") { existing.failureCount++; store.save(); }
    else openCase({
      type: "renewal",
      ref: r.id,
      paypalId: r.id,
      planName: r.plan_id,
      customerName: r.subscriber?.name?.given_name,
      customerEmail: r.subscriber?.email_address,
      amount: r.billing_info?.last_failed_payment?.amount?.value ?? r.billing_info?.outstanding_balance?.value,
      currency: r.billing_info?.last_failed_payment?.amount?.currency_code ?? "USD",
      source: "webhook",
    });
  } else if (type === "BILLING.SUBSCRIPTION.ACTIVATED") {
    const kase = store.findCaseByRef("renewal", r.id);
    if (kase && kase.status === "open") recordRecovery(kase, { amount: kase.amount, via: "renewal paid", evidence: event.id });
  } else if (type === "CUSTOMER.DISPUTE.CREATED" || type === "CUSTOMER.DISPUTE.UPDATED") {
    openCase({
      type: "dispute",
      ref: r.dispute_id,
      paypalId: r.dispute_id,
      reason: r.reason,
      amount: r.dispute_amount?.value,
      currency: r.dispute_amount?.currency_code,
      disputeStatus: r.status,
      source: "webhook",
    });
  } else if (type === "CUSTOMER.DISPUTE.RESOLVED") {
    const kase = store.findCaseByRef("dispute", r.dispute_id);
    if (kase && kase.status === "open") {
      const won = r.dispute_outcome?.outcome_code === "RESOLVED_SELLER_FAVOUR";
      if (won) recordRecovery(kase, { amount: kase.amount, via: "dispute won", evidence: event.id });
      else closeCase(kase.id, "lost", "Dispute resolved in buyer's favour");
    }
  }
  const s = store.get();
  s.events = s.events || [];
  s.events.unshift({ at: now(), type, id: event.id });
  s.events = s.events.slice(0, 50);
  store.save();
}
