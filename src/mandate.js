// The Mandate layer: turns the merchant's plain rules into a verdict for every proposed action.
// Verdicts: "act" (agent proceeds alone), "ask" (needs merchant approval), "refuse" (not allowed).
// Every verdict carries the rule that produced it, so the ledger can show why the agent did what it did.

export function evaluate(action, kase, rules, context = {}) {
  const reasons = [];
  const amount = Number(kase.amount || 0);
  const hour = context.hour ?? localHour(rules.timezone);

  // Hard stops first
  if (kase.contactAttempts >= rules.neverContactAfterAttempts && action.contactsCustomer) {
    return verdict("refuse", `Customer already contacted ${kase.contactAttempts} times (limit ${rules.neverContactAfterAttempts})`);
  }
  if (action.discountPercent > rules.maxAutoDiscountPercent * 2) {
    return verdict("refuse", `Discount ${action.discountPercent}% exceeds twice the auto limit (${rules.maxAutoDiscountPercent}%)`);
  }
  if (action.type === "accept_dispute" && amount > rules.maxAutoActionAmount) {
    return verdict("ask", `Accepting a dispute of ${amount} needs approval`);
  }

  // Things that always need a human
  if (action.type === "submit_dispute_evidence" && !rules.autoSubmitDisputeEvidence) {
    reasons.push("Dispute evidence always needs approval (rule: autoSubmitDisputeEvidence = false)");
  }
  if (action.type === "accept_dispute") {
    reasons.push("Accepting a claim refunds the customer; needs approval");
  }
  if (amount > rules.maxAutoActionAmount) {
    reasons.push(`Amount ${amount} is above the auto-action limit of ${rules.maxAutoActionAmount}`);
  }
  if (action.discountPercent > rules.maxAutoDiscountPercent) {
    reasons.push(`Discount ${action.discountPercent}% is above the auto limit of ${rules.maxAutoDiscountPercent}%`);
  }
  if (action.type === "offer_instalments") {
    reasons.push("Instalment plans change payment terms; needs approval");
  }
  if (action.type === "retry_payment" && !rules.autoRetryFailedRenewals) {
    reasons.push("Automatic retry of failed renewals is switched off");
  }
  if (action.type === "offer_pause" && !rules.autoOfferPause) {
    reasons.push("Offering a pause is switched off for automatic action");
  }
  if (action.type === "send_reminder" && kase.type === "invoice") {
    const overdue = Number(kase.daysOverdue || 0);
    if (overdue < rules.autoChaseInvoicesOverdueDays) {
      reasons.push(`Invoice is ${overdue} days overdue; automatic chasing starts at ${rules.autoChaseInvoicesOverdueDays}`);
    }
  }
  if (action.contactsCustomer && inQuietHours(hour, rules.quietHours)) {
    reasons.push(`Within quiet hours (${rules.quietHours.start}:00 to ${rules.quietHours.end}:00); hold for approval or schedule`);
  }

  if (reasons.length) return verdict("ask", reasons.join("; "));
  return verdict("act", "Within mandate: amount, discount, timing and contact limits all satisfied");
}

// Quiet hours are judged in the merchant's own timezone, not the server's.
export function localHour(timezone) {
  try {
    const h = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: timezone || "UTC" }).format(new Date());
    return Number(h) % 24;
  } catch {
    return new Date().getUTCHours();
  }
}

function inQuietHours(hour, q) {
  if (!q) return false;
  if (q.start > q.end) return hour >= q.start || hour < q.end; // wraps midnight
  return hour >= q.start && hour < q.end;
}

function verdict(verdict, reason) {
  return { verdict, reason };
}

export function describeRules(rules) {
  return [
    `Chase invoices automatically once ${rules.autoChaseInvoicesOverdueDays} days overdue.`,
    `Offer up to ${rules.maxAutoDiscountPercent}% discount without asking; anything higher needs approval, double that is refused.`,
    `Act alone on cases up to ${rules.merchantCurrency || ""}${rules.maxAutoActionAmount}; above that, ask.`,
    rules.autoRetryFailedRenewals ? "Retry failed renewals automatically." : "Ask before retrying failed renewals.",
    rules.autoOfferPause ? "May offer a subscription pause instead of cancellation." : "Ask before offering a pause.",
    rules.autoSubmitDisputeEvidence ? "May submit dispute evidence alone." : "Always ask before submitting dispute evidence.",
    `Never contact a customer more than ${rules.neverContactAfterAttempts} times about one case.`,
    `No messages between ${rules.quietHours.start}:00 and ${rules.quietHours.end}:00 (${rules.timezone || "UTC"}).`,
  ];
}
