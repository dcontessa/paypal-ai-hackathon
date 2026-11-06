// Demo cases so the prototype tells its story without waiting for sandbox events.
import { openCase } from "./engine.js";
import { store } from "./store.js";

const daysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

export function seedDemo() {
  const s = store.get();
  if (s.cases.length) return { seeded: 0 };
  const cases = [
    {
      type: "invoice", ref: "INV-2026-041", customerName: "Amira", customerEmail: "amira@example.com",
      amount: 480, currency: "USD", dueDate: daysAgo(9), daysOverdue: 9, description: "Brand workshop, half-day", source: "demo",
    },
    {
      type: "invoice", ref: "INV-2026-033", customerName: "Daniel", customerEmail: "daniel@example.com",
      amount: 1250, currency: "USD", dueDate: daysAgo(21), daysOverdue: 21, contactAttempts: 1, description: "Quarterly advisory retainer", source: "demo",
    },
    {
      type: "invoice", ref: "INV-2026-019", customerName: "Priya", customerEmail: "priya@example.com",
      amount: 300, currency: "USD", dueDate: daysAgo(3), daysOverdue: 3, description: "Logo refresh", source: "demo",
    },
    {
      type: "renewal", ref: "I-7K2QF9DEMO01", planName: "Pro plan (monthly)", customerName: "Marcus", customerEmail: "marcus@example.com",
      amount: 49, currency: "USD", failureCount: 1, source: "demo",
    },
    {
      type: "renewal", ref: "I-3PX1LZDEMO02", planName: "Team plan (monthly)", customerName: "Sofia", customerEmail: "sofia@example.com",
      amount: 199, currency: "USD", failureCount: 2, contactAttempts: 1, source: "demo",
    },
    {
      type: "dispute", ref: "PP-D-DEMO-5501", reason: "ITEM_NOT_RECEIVED", orderRef: "ORD-8812", customerName: "Lee",
      amount: 89, currency: "USD", trackingNumber: "MY123456789", carrier: "POS_MALAYSIA", deliveredOn: daysAgo(6), deliveryConfirmed: true,
      respondBy: new Date(Date.now() + 6 * 86400_000).toISOString().slice(0, 10), source: "demo",
    },
    {
      type: "dispute", ref: "PP-D-DEMO-5502", reason: "ITEM_NOT_RECEIVED", orderRef: "ORD-8830", customerName: "Jonas",
      amount: 640, currency: "USD", deliveryConfirmed: false,
      respondBy: new Date(Date.now() + 4 * 86400_000).toISOString().slice(0, 10), source: "demo",
    },
  ];
  cases.forEach(openCase);
  // a little history so the counter is not zero on first load
  store.recover({ id: store.id("rec"), caseRef: "INV-2026-007", caseType: "invoice", amount: 720, currency: "USD", via: "invoice paid", evidence: "demo", at: new Date(Date.now() - 2 * 86400_000).toISOString() });
  store.recover({ id: store.id("rec"), caseRef: "I-9AB2CDDEMO00", caseType: "renewal", amount: 49, currency: "USD", via: "renewal paid", evidence: "demo", at: new Date(Date.now() - 1 * 86400_000).toISOString() });
  return { seeded: cases.length };
}
