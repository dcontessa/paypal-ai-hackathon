// Thin PayPal REST client for the sandbox. Covers the endpoints Recoup uses:
// OAuth, Invoicing v2, Subscriptions v1, Disputes v1, Webhooks v1.
// Docs: https://developer.paypal.com/api/rest/

const BASE =
  process.env.PAYPAL_ENV === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";

let tokenCache = { token: null, expires: 0 };

export function configured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET);
}

async function token() {
  if (tokenCache.token && Date.now() < tokenCache.expires - 60_000) return tokenCache.token;
  const auth = Buffer.from(
    `${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`
  ).toString("base64");
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new Error(`PayPal auth failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

async function call(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`PayPal ${method} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

// ---------- Invoicing v2 ----------

export async function listInvoices({ page = 1, pageSize = 50 } = {}) {
  const data = await call("GET", `/v2/invoicing/invoices?page=${page}&page_size=${pageSize}&total_required=true`);
  return data.items || [];
}

export async function getInvoice(id) {
  return call("GET", `/v2/invoicing/invoices/${id}`);
}

export async function createInvoice({ recipientEmail, recipientName, amount, currency, description, dueDate, invoiceNumber }) {
  const body = {
    detail: {
      invoice_number: invoiceNumber,
      currency_code: currency,
      note: description,
      payment_term: dueDate ? { due_date: dueDate } : { term_type: "NET_10" },
    },
    primary_recipients: [
      {
        billing_info: {
          name: { given_name: recipientName || "Customer" },
          email_address: recipientEmail,
        },
      },
    ],
    items: [
      {
        name: description || "Services",
        quantity: "1",
        unit_amount: { currency_code: currency, value: Number(amount).toFixed(2) },
      },
    ],
  };
  const created = await call("POST", "/v2/invoicing/invoices", body);
  // POST returns a link to the draft; fetch the full invoice
  const id = created.id || created.href?.split("/").pop();
  return getInvoice(id);
}

export async function sendInvoice(id, { subject, note } = {}) {
  return call("POST", `/v2/invoicing/invoices/${id}/send`, {
    send_to_recipient: true,
    send_to_invoicer: false,
    subject,
    note,
  });
}

export async function remindInvoice(id, { subject, note }) {
  return call("POST", `/v2/invoicing/invoices/${id}/remind`, {
    subject,
    note,
    send_to_recipient: true,
    send_to_invoicer: false,
  });
}

// Records a payment made outside PayPal (used to close an invoice after an agreed instalment or transfer).
export async function recordInvoicePayment(id, { amount, currency, method = "OTHER", note }) {
  return call("POST", `/v2/invoicing/invoices/${id}/payments`, {
    method,
    note,
    payment_date: new Date().toISOString().slice(0, 10),
    amount: { currency_code: currency, value: Number(amount).toFixed(2) },
  });
}

// ---------- Subscriptions v1 ----------

export async function getSubscription(id) {
  return call("GET", `/v1/billing/subscriptions/${id}`);
}

export async function suspendSubscription(id, reason) {
  return call("POST", `/v1/billing/subscriptions/${id}/suspend`, { reason });
}

export async function activateSubscription(id, reason) {
  return call("POST", `/v1/billing/subscriptions/${id}/activate`, { reason });
}

export async function listSubscriptionTransactions(id, start, end) {
  return call("GET", `/v1/billing/subscriptions/${id}/transactions?start_time=${start}&end_time=${end}`);
}

// ---------- Disputes v1 ----------

export async function listDisputes() {
  const data = await call("GET", "/v1/customer/disputes?page_size=50");
  return data.items || [];
}

export async function getDispute(id) {
  return call("GET", `/v1/customer/disputes/${id}`);
}

export async function sendDisputeMessage(id, message) {
  return call("POST", `/v1/customer/disputes/${id}/send-message`, { message });
}

export async function acceptClaim(id, note) {
  return call("POST", `/v1/customer/disputes/${id}/accept-claim`, {
    note,
    accept_claim_reason: "COMPANY_POLICY",
  });
}

// Evidence submission is multipart in the real API. For text-only evidence we use the JSON form
// documented under "provide evidence" with a notes payload. Files (tracking docs, screenshots)
// are a follow-up for the production version.
export async function provideEvidence(id, { note, trackingNumber, carrier }) {
  const boundary = `----recoup${Date.now()}`;
  const input = {
    evidences: [
      {
        evidence_type: "PROOF_OF_FULFILLMENT",
        evidence_info: trackingNumber
          ? { tracking_info: [{ carrier_name: carrier || "OTHER", tracking_number: trackingNumber }] }
          : undefined,
        notes: note,
      },
    ],
  };
  const body =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="input"; filename="input.json"\r\n` +
    `Content-Type: application/json\r\n\r\n` +
    `${JSON.stringify(input)}\r\n--${boundary}--\r\n`;
  const res = await fetch(`${BASE}/v1/customer/disputes/${id}/provide-evidence`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${await token()}`,
      "Content-Type": `multipart/related; boundary=${boundary}`,
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`provide-evidence failed ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

// ---------- Webhooks v1 ----------

export const WEBHOOK_EVENTS = [
  "INVOICING.INVOICE.PAID",
  "INVOICING.INVOICE.CANCELLED",
  "BILLING.SUBSCRIPTION.PAYMENT.FAILED",
  "BILLING.SUBSCRIPTION.SUSPENDED",
  "BILLING.SUBSCRIPTION.ACTIVATED",
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "CUSTOMER.DISPUTE.RESOLVED",
];

export async function ensureWebhook(publicUrl) {
  const url = `${publicUrl.replace(/\/$/, "")}/webhooks/paypal`;
  const existing = await call("GET", "/v1/notifications/webhooks");
  const found = (existing.webhooks || []).find((w) => w.url === url);
  if (found) return found;
  return call("POST", "/v1/notifications/webhooks", {
    url,
    event_types: WEBHOOK_EVENTS.map((name) => ({ name })),
  });
}

export async function verifyWebhookSignature(headers, body, webhookId) {
  return call("POST", "/v1/notifications/verify-webhook-signature", {
    auth_algo: headers["paypal-auth-algo"],
    cert_url: headers["paypal-cert-url"],
    transmission_id: headers["paypal-transmission-id"],
    transmission_sig: headers["paypal-transmission-sig"],
    transmission_time: headers["paypal-transmission-time"],
    webhook_id: webhookId,
    webhook_event: body,
  });
}

// ---------- Transaction search ----------

export async function listTransactions(daysBack = 30) {
  const end = new Date();
  const start = new Date(end.getTime() - daysBack * 86400_000);
  const data = await call(
    "GET",
    `/v1/reporting/transactions?start_date=${start.toISOString()}&end_date=${end.toISOString()}&fields=all&page_size=100`
  );
  return data.transaction_details || [];
}
