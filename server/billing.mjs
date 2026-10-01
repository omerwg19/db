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
    throw new Error(`Payment provider returned ${res.status}`);
  }
  if (!res.ok) throw new Error(body?.error?.message || `Payment provider returned ${res.status}`);
  return body;
}

// Re-reads the payment from the provider. Used to confirm a webhook rather
// than trusting the callback body, which is how a spoofed "finished" status
// would otherwise grant access.
export async function confirmPayment(paymentId) {
  return api(`/payment/${encodeURIComponent(paymentId)}`);
}

export async function createCheckout({ user, plan, origin, ip }) {
  const spec = CHECKOUT_PLANS[plan];
  if (!spec) throw new Error("Unknown plan");
  const price = PLANS[plan];
  const payCurrency = String(process.env.CRYPTO_PAY_CURRENCY ?? "btc").trim() || "btc";

  const invoice = await api("/payment", {
    method: "POST",
    body: JSON.stringify({
      price_amount: spec.amountUsd,
      price_currency: "usd",
      pay_currency: payCurrency,
      // Our own payment row id is the link between callback and account.
      order_id: `p${user.id}`,
      order_description: `Veriscope ${price.label} - ${price.periodDays} days`,
      ip_address: ip && ip.includes(".") ? ip : undefined,
      success_url: `${origin}/dashboard.html?paid=1`,
      cancel_url: `${origin}/pricing.html`,
    }),
  });

  return {
    paymentId: String(invoice.payment_id),
    paymentUrl: invoice.payment_url,
    payAmount: invoice.pay_amount,
    payCurrency: invoice.pay_currency ?? payCurrency,
    priceAmount: spec.amountUsd,
    priceCurrency: "usd",
    orderId: String(invoice.order_id ?? `p${user.id}`),
    periodDays: price.periodDays,
  };
}