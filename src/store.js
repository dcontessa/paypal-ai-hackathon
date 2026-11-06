// Minimal JSON-file store. Good enough for a prototype; swap for Postgres later.
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.resolve("data");
const FILE = path.join(DATA_DIR, "recoup.json");

const defaults = () => ({
  merchant: {
    name: "Demo Merchant",
    currency: "USD",
  },
  rules: {
    // Plain-language mandate the merchant gives the agent. The rules engine turns it into verdicts.
    autoChaseInvoicesOverdueDays: 7,       // chase automatically once an invoice is this many days overdue
    maxAutoDiscountPercent: 5,             // the agent may offer up to this discount without asking
    maxAutoActionAmount: 500,              // any action on a case above this amount needs approval
    autoRetryFailedRenewals: true,         // retry failed subscription payments without asking
    autoOfferPause: true,                  // may offer a pause instead of cancellation without asking
    autoSubmitDisputeEvidence: false,      // dispute responses always need approval
    neverContactAfterAttempts: 3,          // stop chasing a customer after this many messages
    quietHours: { start: 21, end: 8 },     // do not send messages between these hours (merchant local time)
    timezone: process.env.MERCHANT_TIMEZONE || "Asia/Kuala_Lumpur", // timezone the quiet hours are judged in
    tone: "warm and professional",
  },
  cases: [],       // open and closed leak cases
  actions: [],     // every proposed action, with verdict and outcome
  ledger: [],      // money recovered, with evidence
  subscriptions: [], // subscription ids this app knows about
  webhookId: null,
});

let state = null;

function load() {
  if (state) return state;
  try {
    state = JSON.parse(fs.readFileSync(FILE, "utf8"));
    // forward-compatible merge of defaults
    const d = defaults();
    state = { ...d, ...state, rules: { ...d.rules, ...(state.rules || {}) } };
  } catch {
    state = defaults();
  }
  return state;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(state, null, 2));
}

export const store = {
  get: () => load(),
  save,
  reset() {
    state = defaults();
    save();
  },
  id(prefix) {
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  },
  upsertCase(c) {
    const s = load();
    const i = s.cases.findIndex((x) => x.id === c.id);
    if (i >= 0) s.cases[i] = { ...s.cases[i], ...c };
    else s.cases.push(c);
    save();
    return c;
  },
  findCaseByRef(type, ref) {
    return load().cases.find((c) => c.type === type && c.ref === ref);
  },
  addAction(a) {
    const s = load();
    s.actions.unshift(a);
    save();
    return a;
  },
  updateAction(id, patch) {
    const s = load();
    const a = s.actions.find((x) => x.id === id);
    if (!a) return null;
    Object.assign(a, patch);
    save();
    return a;
  },
  recover(entry) {
    const s = load();
    s.ledger.unshift(entry);
    save();
    return entry;
  },
  totals() {
    const s = load();
    const recovered = s.ledger.reduce((sum, e) => sum + Number(e.amount || 0), 0);
    const open = s.cases.filter((c) => c.status === "open");
    const atRisk = open.reduce((sum, c) => sum + Number(c.amount || 0), 0);
    return {
      recovered,
      atRisk,
      openCases: open.length,
      pendingApprovals: s.actions.filter((a) => a.verdict === "ask" && a.status === "pending").length,
      currency: s.merchant.currency,
    };
  },
};
