// The agent layer. Given a leak case, propose the single best next recovery action with a drafted
// customer message. Uses Claude when ANTHROPIC_API_KEY is set, otherwise a deterministic template
// agent so the prototype runs anywhere.

import Anthropic from "@anthropic-ai/sdk";

const ACTION_TYPES = {
  invoice: ["send_reminder", "offer_discount", "offer_instalments", "escalate_to_merchant"],
  renewal: ["retry_payment", "offer_pause", "request_new_payment_method", "escalate_to_merchant"],
  dispute: ["submit_dispute_evidence", "message_buyer", "accept_dispute", "escalate_to_merchant"],
};

export async function propose(kase, rules, merchant) {
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      return await proposeWithClaude(kase, rules, merchant);
    } catch (err) {
      console.error("Claude proposal failed, falling back to template agent:", err.message);
    }
  }
  return proposeWithTemplate(kase, rules, merchant);
}

async function proposeWithClaude(kase, rules, merchant) {
  const client = new Anthropic();
  const system = `You are Recoup, a revenue recovery agent working for ${merchant.name}. You recover money the merchant has already earned: unpaid invoices, failed subscription renewals and payment disputes. You are fair to customers: when the evidence favours the customer, say so and recommend accepting the claim. Tone: ${rules.tone}. Never threaten, never invent facts, never promise what the merchant has not authorised.

Decision guide:
- Invoices: first contact -> send_reminder. Already reminded and more than 14 days overdue -> offer_discount (up to the merchant's maxAutoDiscountPercent). Reminded twice and more than 30 days overdue -> offer_instalments.
- Renewals: first failure -> retry_payment. Second or later failure -> offer_pause, or request_new_payment_method if the failure looks like an expired card.
- Disputes: if there is delivery proof (trackingNumber or deliveryConfirmed) -> submit_dispute_evidence with a structured evidence note and a realistic winLikelihood. If there is no delivery proof for an item-not-received claim -> accept_dispute and say plainly that the buyer is likely right. Use message_buyer only when a clarifying question would change the outcome.
- escalate_to_merchant is a last resort for cases that are ambiguous or outside the merchant's business; it is not a safe default. The mandate layer, not you, decides whether an action needs approval, so propose the best action even when it will need approval.

Style: short sentences, plain words, no em dashes, no exclamation marks, sign off with the merchant name. Reply with JSON only.`;

  const user = `Case:\n${JSON.stringify(kase, null, 2)}\n\nMerchant rules:\n${JSON.stringify(rules, null, 2)}\n\nChoose ONE next action from ${JSON.stringify(ACTION_TYPES[kase.type])}. Respond with JSON:\n{"type": string, "rationale": string (one sentence), "discountPercent": number (0 if none), "contactsCustomer": boolean, "subject": string, "message": string (the full customer message, or evidence notes for disputes), "winLikelihood": number 0-100 (disputes only, else null)}`;

  const res = await client.messages.create({
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-5",
    max_tokens: 800,
    system,
    messages: [{ role: "user", content: user }],
  });
  const text = res.content.map((c) => c.text || "").join("");
  const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  const parsed = JSON.parse(json);
  if (!ACTION_TYPES[kase.type].includes(parsed.type)) parsed.type = "escalate_to_merchant";
  return { ...parsed, source: "claude" };
}

export function proposeWithTemplate(kase, rules, merchant) {
  const name = kase.customerName || "there";
  const amt = `${kase.currency} ${Number(kase.amount).toFixed(2)}`;
  const sign = `\n\n${merchant.name}`;

  if (kase.type === "invoice") {
    const overdue = Number(kase.daysOverdue || 0);
    if (kase.contactAttempts >= 2 && overdue > 30) {
      return {
        type: "offer_instalments",
        rationale: `Two reminders and ${overdue} days overdue; an instalment plan converts a stuck invoice into cash flow.`,
        discountPercent: 0,
        contactsCustomer: true,
        subject: `A simpler way to settle invoice ${kase.ref}`,
        message: `Hi ${name},\n\nI know things get busy. Invoice ${kase.ref} for ${amt} is still open, and rather than keep sending reminders I would like to make it easy: we can split it into three monthly payments, starting whenever suits you this month. Reply with a date that works and I will send the first payment link.${sign}`,
        winLikelihood: null,
        source: "template",
      };
    }
    if (kase.contactAttempts >= 1 && overdue > 14) {
      return {
        type: "offer_discount",
        rationale: `Already reminded once; a small prompt-payment discount within mandate usually closes it.`,
        discountPercent: Math.min(rules.maxAutoDiscountPercent, 5),
        contactsCustomer: true,
        subject: `Invoice ${kase.ref}: settle this week and save ${Math.min(rules.maxAutoDiscountPercent, 5)}%`,
        message: `Hi ${name},\n\nA quick follow-up on invoice ${kase.ref} (${amt}), now ${overdue} days past due. If it is settled by Friday I am happy to take ${Math.min(rules.maxAutoDiscountPercent, 5)}% off as a thank-you for closing it out. The payment link is in the original invoice email, or reply here and I will resend it.${sign}`,
        winLikelihood: null,
        source: "template",
      };
    }
    return {
      type: "send_reminder",
      rationale: `First contact on an invoice ${overdue} days overdue; a friendly reminder recovers most invoices on its own.`,
      discountPercent: 0,
      contactsCustomer: true,
      subject: `Friendly reminder: invoice ${kase.ref} is due`,
      message: `Hi ${name},\n\nJust a gentle nudge that invoice ${kase.ref} for ${amt} was due on ${kase.dueDate || "the agreed date"}. You can pay in one click from the invoice email. If anything about it needs adjusting, reply and I will sort it out straight away.${sign}`,
      winLikelihood: null,
      source: "template",
    };
  }

  if (kase.type === "renewal") {
    if (kase.failureCount >= 2) {
      return {
        type: "offer_pause",
        rationale: `Second failed attempt; offering a pause keeps the customer instead of letting the subscription lapse.`,
        discountPercent: 0,
        contactsCustomer: true,
        subject: `Keep your ${kase.planName || "subscription"}: pause instead of cancel`,
        message: `Hi ${name},\n\nYour renewal of ${amt} for ${kase.planName || "your subscription"} did not go through again. No action has been taken on your account yet. If now is not the right time, I can pause your plan for a month at no cost and you keep everything you have. Or, if the card simply expired, update it here and we are back on track. Just reply "pause" or "update".${sign}`,
        winLikelihood: null,
        source: "template",
      };
    }
    return {
      type: "retry_payment",
      rationale: `First failure, most are transient (limits, expired card). Let the customer know and retry in 3 days.`,
      discountPercent: 0,
      contactsCustomer: true,
      subject: `Payment for ${kase.planName || "your subscription"} did not go through`,
      message: `Hi ${name},\n\nThe renewal payment of ${amt} for ${kase.planName || "your subscription"} could not be processed. This is usually a card limit or an expired card. We will try again in three days; if you would like to update your payment method before then, you can do so from your PayPal account. Your access continues in the meantime.${sign}`,
      winLikelihood: null,
      source: "template",
    };
  }

  if (kase.type === "dispute") {
    const hasProof = Boolean(kase.trackingNumber || kase.deliveryConfirmed);
    if (kase.reason === "ITEM_NOT_RECEIVED" && !hasProof) {
      return {
        type: "accept_dispute",
        rationale: `No delivery proof on file for an item-not-received claim; fighting it wastes time and goodwill. Recommend accepting and refunding.`,
        discountPercent: 0,
        contactsCustomer: false,
        subject: `Dispute ${kase.ref}: recommend accepting`,
        message: `No tracking or delivery confirmation exists for order ${kase.orderRef || ""}. The buyer's claim is likely to succeed. Accepting now avoids a chargeback fee and keeps the customer relationship intact.`,
        winLikelihood: 15,
        source: "template",
      };
    }
    return {
      type: "submit_dispute_evidence",
      rationale: `Delivery proof and order history support the merchant; a structured evidence pack has a strong chance.`,
      discountPercent: 0,
      contactsCustomer: false,
      subject: `Evidence pack for dispute ${kase.ref}`,
      message: `Order ${kase.orderRef || kase.ref} for ${amt} was fulfilled as described. Tracking ${kase.trackingNumber || "n/a"} shows delivery${kase.deliveredOn ? ` on ${kase.deliveredOn}` : ""} to the address on the order. The buyer's messages prior to the dispute raised no complaint about the item. We request the dispute be resolved in the seller's favour.`,
      winLikelihood: 78,
      source: "template",
    };
  }

  return {
    type: "escalate_to_merchant",
    rationale: "Unknown case type.",
    discountPercent: 0,
    contactsCustomer: false,
    subject: "Needs a human",
    message: "",
    winLikelihood: null,
    source: "template",
  };
}
