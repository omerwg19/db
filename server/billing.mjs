// NOWPayments integration for prepaid Pro access.
//
// Crypto has no mandates, so there is no true auto-renewal: each confirmed
// payment buys a fixed number of days, and expiry is handled by comparing
// plan_expires_at at read time. Nothing here decides on its own that money
// arrived -- the amount and status are confirmed against the provider and the
// webhook signature must verify before an account is ever upgraded.
import { createHmac, timingSafeEqual } from "node:crypto";
import { PLANS, CHECKOUT_PLANS } from "./auth.mjs";

const API = process.env.NOWPAYMENTS_SANDBOX === "1"
  ? "https://api-sandbox.nowpayments.io/v1"
  : "https://api.nowpayments.io/v1";

const apiKey = String(process.env.NOWPAYMENTS_API_KEY ?? "").trim();
const ipnSecret = String(process.env.NOWPAYMENTS_IPN_SECRET ?? "").trim();

export function billingConfigured() {
  return { api: !!apiKey, ipnSecret: !!ipnSecret, sandbox: API.includes("sandbox") };
}

// The provider signs a canonical form of the payload: keys sorted at every
// depth, then JSON-encoded. Signing the raw bytes we happened to receive
// instead would make every signature comparison fail.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function verifyIpnSignature(payload, signature) {
  if (!ipnSecret || !signature) return false;
  const expected = createHmac("sha512", ipnSecret).update(canonical(payload)).digest("hex");
  const got = String(signature).trim();
  // HMAC digests are fixed width, so a length mismatch can only be an attack
  // or a truncated header; comparing unequal lengths throws.
  if (got.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(got, "hex"), Buffer.from(expected, "hex"));
  } catch {
    return false;
  }
}

async function api(path, init = {}) {
  if (!apiKey) throw new Error("NOWPayments is not configured");
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { "x-api-key": apiKey, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`Payment provider returned ${res.status} with an unreadable body`);
  }
  if (!res.ok) {
    // Surface the reason instead of a bare status. This used to collapse every
    // failure into one generic message, which made a rejected request body
    // indistinguishable from an unreachable network.
    const reason = body?.error?.message || body?.message || `status ${res.status}`;
    throw Object.assign(new Error(reason), { status: res.status, provider: true });
  }
  return body;
}

// Re-reads the payment from the provider. Used to confirm a webhook rather
// than trusting the callback body, which is how a spoofed "finished" status
// would otherwise grant access.
export async function confirmPayment(paymentId) {
  return api(`/payment/${encodeURIComponent(paymentId)}`);
}

// An invoice is used rather than a direct payment because /v1/invoice treats
// pay_currency as optional: omit it and the hosted page lets the buyer choose
// their own coin. /v1/payment always fixes one currency and one deposit
// address. CRYPTO_PAY_CURRENCY pins the currency instead, which is also what
// the /payment fallback below needs.
// Both figures are crypto, so this comparison is meaningful; comparing
// actually_paid against the USD price is not, since 0.0003 BTC against $10 is
// "underpaid" forever. Falls back to the provider's own status when either
// number is absent or zero, which is common -- their documented sample carries
// actually_paid_at_fiat: 0.
export const PAYMENT_SHORTFALL_TOLERANCE = 0.01;

export function paymentShortfall(remote) {
  const status = String(remote?.payment_status ?? "");
  if (status !== "finished") return "not finished";
  const expected = Number(remote?.pay_amount ?? 0);
  const received = Number(remote?.actually_paid ?? 0);
  if (!(expected > 0) || !(received > 0)) return null;
  // 1% covers provider rounding on the required amount.
  if (received < expected * (1 - PAYMENT_SHORTFALL_TOLERANCE)) {
    return `short by ${expected - received} ${String(remote?.pay_currency ?? "")}`;
  }
  return null;
}

export async function createCheckout({ user, plan, origin, ip }) {
  const spec = CHECKOUT_PLANS[plan];
  if (!spec) throw new Error("Unknown plan");
  const price = PLANS[plan];
  const pinned = String(process.env.CRYPTO_PAY_CURRENCY ?? "").trim();

  // Only the parameters /v1/invoice actually accepts. /v1/payment documents a
  // wider set -- ipn_allowed_updates, ipn_checkout_url and ip_address among
  // them -- and sending those to this endpoint makes the whole request fail
  // with an opaque error, which is how a perfectly good key looks broken.
  const body = {
    price_amount: spec.amountUsd,
    price_currency: "usd",
    order_id: `p${user.id}`,
    order_description: `Veriscope ${price.label} - ${price.periodDays} days`,
    ipn_callback_url: `${origin}/api/billing/webhook`,
    success_url: `${origin}/dashboard.html?paid=1`,
    cancel_url: `${origin}/pricing.html`,
    // Undefined is dropped during JSON.stringify, which is what leaves the
    // choice with the buyer.
    pay_currency: pinned || undefined,
  };

  let invoice;
  let isInvoice = true;
  try {
    invoice = await api("/invoice", { method: "POST", body: JSON.stringify(body) });
  } catch (err) {
    // Not every account has the invoice endpoint enabled. Fall back to a direct
    // payment, which requires a currency to be pinned.
    if (!pinned) throw err;
    isInvoice = false;
    invoice = await api("/payment", { method: "POST", body: JSON.stringify(body) });
  }

  // The webhook has to find its way back to this purchase. An invoice callback
  // carries payment_id for the underlying deposit, so match on whichever
  // identifier we stored.
  const providerRef = isInvoice ? String(invoice.id) : String(invoice.payment_id);
  return {
    providerRef,
    paymentUrl: isInvoice ? invoice.invoice_url : invoice.payment_url,
    payAmount: invoice.pay_amount,
    payCurrency: invoice.pay_currency ?? pinned ?? "customer choice",
    priceAmount: spec.amountUsd,
    priceCurrency: "usd",
    orderId: String(invoice.order_id ?? `p${user.id}`),
    periodDays: price.periodDays,
    multiCurrency: !pinned,
  };
}