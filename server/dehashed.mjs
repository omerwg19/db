// DeHashed breach search.
//
// The lookup used to invent its results, so there was nothing real to show.
// This calls the actual API. Three things are deliberate:
//
//  1. Credentials in the response are never returned. DeHashed regularly hands
//     back plaintext passwords from stealer logs. This app reports which fields
//     a leaked record contained, never their values: that is what someone
//     checking an exposure actually needs, and it keeps the site from becoming
//     a credential dispenser.
//  2. The published auth and response shapes differ between DeHashed's own
//     docs and third-party integrations, and the API has been versioned at
//     least once. Rather than betting on one shape and failing in a way that
//     looks like an outage, the response is read liberally and the auth mode
//     can be switched with an environment variable.
//  3. Every query costs the account a credit, so a malformed identifier is
//     rejected before it reaches the network.

const env = (name, fallback = "") => String(process.env[name] ?? "").trim() || fallback;

const ENDPOINT = "https://api.dehashed.com/search";
const TIMEOUT_MS = 20_000;
const MAX_HITS = 50;

// detectKind() in index.mjs names things for the interface; DeHashed searches
// by field name. Discord snowflakes and anything unrecognised have no
// equivalent, so they are refused here rather than spending a credit to return
// nothing.
const FIELD_FOR_KIND = {
  Email: "email",
  Domain: "domain",
  Phone: "phone",
  IP: "ip_address",
  Username: "username",
};

export const ATTRIBUTION = "Breach data from DeHashed";

export function status() {
  const key = env("DEHASHED_API_KEY");
  return {
    configured: Boolean(key),
    mode: env("DEHASHED_AUTH_MODE", "basic").toLowerCase(),
    // The address itself, not whether one was set: authHeader() signs with it,
    // and a boolean here silently produced the username "true".
    email: env("DEHASHED_API_EMAIL"),
    key,
  };
}

export class LookupError extends Error {
  constructor(message, { status = 502, detail = "" } = {}) {
    super(message);
    this.status = status;
    this.detail = detail;
  }
}

// Quoting keeps an identifier from being read as query syntax: without it a
// value containing a space or a colon silently searches the wrong thing.
function quote(value) {
  return `"${String(value).replace(/(["\\])/g, "\\$1")}"`;
}

function authHeader() {
  const { key, mode, email } = status();
  if (mode === "bearer") return `Bearer ${key}`;
  // Documented as "email:API-key"; the key alone as the username also appears
  // in the wild for accounts that have no email on file.
  return `Basic ${Buffer.from(`${email || key}:${key}`).toString("base64")}`;
}

// The API has used entries, data and database for the result array depending on
// version, and returns null for the array when nothing matched.
function extractEntries(body) {
  for (const field of ["entries", "data", "database"]) {
    const value = body?.[field];
    if (Array.isArray(value)) return value;
  }
  return [];
}

const FIELD_LABELS = [
  ["password", "plaintext password"],
  ["hashed_password", "password hash"],
  ["email", "email"],
  ["username", "username"],
  ["ip_address", "IP address"],
  ["name", "name"],
  ["phone", "phone"],
  ["address", "address"],
  ["vin", "vehicle ID"],
];

function presentFields(entry) {
  return FIELD_LABELS.filter(([key]) => {
    const value = entry?.[key];
    return typeof value === "string" ? value.length > 0 : value != null;
  }).map(([, label]) => label);
}

// A record carrying a credential is direct evidence of exposure; one with a few
// identifiers and no credential is weaker, and saying otherwise would overstate
// what the data shows.
function confidenceOf(entry, fields) {
  if (entry?.password || entry?.hashed_password) return "high";
  if (fields.length >= 3) return "medium";
  return "low";
}

function toHit(entry, kind) {
  const fields = presentFields(entry);
  return {
    source: entry?.database_name || entry?.source || "Unattributed source",
    kind,
    // DeHashed records carry the breach name more reliably than its date, so
    // the date column says what is actually known rather than inventing one.
    breached: entry?.date || entry?.breach_date || "Date not published",
    fields,
    confidence: confidenceOf(entry, fields),
  };
}

export async function search({ kind, input, size = 100 }) {
  const { configured } = status();
  if (!configured) {
    throw new LookupError("Lookups are not configured on this server yet.", { status: 503 });
  }

  const field = FIELD_FOR_KIND[kind];
  if (!field) {
    throw new LookupError(
      kind === "Unknown"
        ? "That does not look like an email, domain, phone number, IP or username."
        : `${kind} lookups are not supported by the current source.`,
      { status: 400 },
    );
  }

  const url = `${ENDPOINT}?query=${encodeURIComponent(`${field}:${quote(input)}`)}&size=${size}`;

  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json", Authorization: authHeader() },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError";
    throw new LookupError(
      timedOut
        ? "The data source did not respond in time. Try again."
        : "Could not reach the data source. Try again shortly.",
      { status: 502, detail: err?.message },
    );
  }

  if (res.status === 401 || res.status === 403) {
    throw new LookupError("The data source rejected our credentials.", { status: 502 });
  }
  if (res.status === 402) {
    // DeHashed returns 402 when the subscription or credits are gone. Worth
    // saying plainly: it means nobody can search until it is topped up.
    throw new LookupError("The data source has no queries left. The subscription needs topping up.", {
      status: 503,
    });
  }
  if (res.status === 429 || res.status === 400) {
    throw new LookupError("The data source is rate limiting us. Try again in a moment.", {
      status: 429,
    });
  }
  if (!res.ok) {
    throw new LookupError(`The data source returned an error (HTTP ${res.status}).`, { status: 502 });
  }

  let body;
  try {
    body = await res.json();
  } catch {
    throw new LookupError("The data source sent a response we could not read.", { status: 502 });
  }

  // A 200 can still carry a complaint, which is how "no subscription" shows up.
  if (body?.message && !extractEntries(body).length) {
    throw new LookupError(String(body.message).slice(0, 200), { status: 502 });
  }

  const entries = extractEntries(body);
  const total = Number(body?.total ?? entries.length) || entries.length;

  return {
    hits: entries.slice(0, MAX_HITS).map((entry) => toHit(entry, kind)),
    total,
    truncated: total > MAX_HITS,
  };
}