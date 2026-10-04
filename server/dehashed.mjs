// DeHashed breach search.
//
// The lookup used to invent its results, so there was nothing real to show.
// This calls the actual API.
//
// The shape below is the current one: POST /v2/search with the key in a
// Dehashed-Api-Key header and the query in a JSON body. Earlier versions used
// GET /search with HTTP Basic auth and that path now answers 404, so anything
// written against the older guides fails in a way that looks like an outage
// rather than a version bump.
//
// Two deliberate choices:
//
//  1. Credentials in the response are never returned. DeHashed regularly hands
//     back plaintext passwords from stealer logs. This app reports which fields
//     a leaked record contained, never their values: that is what someone
//     checking an exposure actually needs, and it keeps the site from becoming
//     a credential dispenser.
//  2. Every query costs a credit, so an identifier that cannot be matched to a
//     searchable field is rejected before the request is made.

const env = (name, fallback = "") => String(process.env[name] ?? "").trim() || fallback;

const ENDPOINT = "https://api.dehashed.com/v2/search";
const TIMEOUT_MS = 20_000;
const MAX_HITS = 50;
const PAGE_SIZE = 100;

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
  return { configured: Boolean(env("DEHASHED_API_KEY")), key: env("DEHASHED_API_KEY") };
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

// The array has been entries, data and database across versions, and comes back
// null rather than empty when nothing matched.
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

// Non-credential fields are shown as the actual values from the leaked record.
// That is what makes a result useful -- "this address was in a breach alongside
// this username and IP" is the finding; a list of column names is not.
const DETAIL_LABELS = [
  ["email", "Email"],
  ["username", "Username"],
  ["name", "Name"],
  ["phone", "Phone"],
  ["ip_address", "IP address"],
  ["address", "Address"],
  ["domain", "Domain"],
  ["vin", "Vehicle ID"],
];

function detailsOf(entry) {
  const details = [];
  for (const [key, label] of DETAIL_LABELS) {
    const value = entry?.[key];
    if (typeof value === "string" && value.length) details.push({ label, value });
  }
  return details;
}

// Presence and shape only, never the value. A recovered plaintext password is a
// working credential for someone else's account, and publishing one on a
// searchable page is an account-takeover service no matter how the page frames
// it. Its length and type are enough to tell a real exposure from a stale one.
function credentialOf(entry) {
  for (const [key, type] of [
    ["password", "plaintext"],
    ["hashed_password", "hash"],
  ]) {
    const value = entry?.[key];
    if (typeof value === "string" && value.length) {
      return { present: true, type, length: value.length };
    }
  }
  return { present: false, type: null, length: 0 };
}

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
    // DeHashed records carry the breach name far more reliably than its date,
    // so the date says what is actually known rather than inventing one.
    breached: entry?.date || entry?.breach_date || "Date not published",
    fields,
    details: detailsOf(entry),
    credential: credentialOf(entry),
    confidence: confidenceOf(entry, fields),
  };
}

// What makes a breach record worth reading is that its fields travel together.
// A username here and a physical address there are usually the same person, and
// the combination is what lets an attacker confirm a target or fill in a blank on
// a form they already half-know. So the shared values are grouped across the
// result set rather than left to be eyeballed one card at a time.
//
// The credential is counted here exactly like any other field -- it is only ever
// a yes/no and a length. Grouping it does not reveal it, and hiding it would
// make this panel lie: "exposed alongside 3 other accounts" is the actual risk,
// and it is true whether or not the value is displayed.
const SHARED_STRENGTH = { "IP address": "high", Username: "high", Phone: "high", "Physical address": "high", VIN: "high", Email: "medium", Name: "low", Domain: "low" };

function correlate(hits, query) {
  const groups = new Map();
  const sourcesFor = (value) => hits.filter((h) => h.details.some((d) => d.value === value)).map((h) => h.source);
  const seen = new Set();
  // Whatever was just searched for is trivially present in every record, so
  // listing it as a connection would pad the panel with something the reader
  // already knows. The other fields are the ones doing the linking.
  const self = typeof query === "string" ? query.trim().toLowerCase() : "";

  for (const hit of hits) {
    for (const { label, value } of hit.details) {
      const key = label + "" + value.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      if (value.trim().toLowerCase() === self) continue;
      if (!groups.has(value)) groups.set(value, { value, label, sources: sourcesFor(value) });
    }
  }

  const nodes = [...groups.values()]
    .filter((g) => g.sources.length > 1)
    .map((g) => ({
      label: g.label,
      value: g.value,
      sources: [...new Set(g.sources)],
      strength: SHARED_STRENGTH[g.label] || "low",
    }))
    .sort((a, b) => b.sources.length - a.sources.length || a.label.localeCompare(b.label));

  const credentialBreaches = hits.filter((h) => h.credential.present);
  const reused = credentialBreaches.length > 1;

  return {
    nodes,
    // The headline number: distinct accounts in the result set that were breached
    // alongside a credential. One is a leak, several is a fill-in-the-blank list.
    exposure: {
      breaches: hits.length,
      withCredential: credentialBreaches.length,
      credentialType: credentialBreaches[0]?.credential?.type || null,
      reused,
      sourceCount: new Set(hits.map((h) => h.source)).size,
    },
  };
}

export async function search({ kind, input, size = PAGE_SIZE }) {
  const { configured, key } = status();
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

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Dehashed-Api-Key": key },
      body: JSON.stringify({
        query: `${field}:${quote(input)}`,
        page: 1,
        size,
        wildcard: false,
        regex: false,
        de_dupe: true,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (err) {
    throw new LookupError(
      err?.name === "TimeoutError"
        ? "The data source did not respond in time. Try again."
        : "Could not reach the data source. Try again shortly.",
      { status: 502, detail: err?.message },
    );
  }

  const body = await res.json().catch(() => null);

  if (res.status === 401 || res.status === 403) {
    throw new LookupError("The data source rejected our API key.", { status: 502, detail: body?.error });
  }
  if (res.status === 402) {
    // Worth saying plainly: nobody can search until the subscription or credits
    // are topped up, and "an error occurred" would not tell anyone that.
    throw new LookupError("The data source has no queries left. The subscription needs topping up.", {
      status: 503,
      detail: body?.error,
    });
  }
  if (res.status === 429) {
    throw new LookupError("The data source is rate limiting us. Try again in a moment.", { status: 429 });
  }
  if (!res.ok) {
    throw new LookupError(`The data source returned an error (HTTP ${res.status}).`, {
      status: 502,
      detail: body?.error || body?.message,
    });
  }

  // A 200 can still carry a complaint, which is how some quota states surface.
  if (!body) {
    throw new LookupError("The data source sent a response we could not read.", { status: 502 });
  }
  if (body.error && !extractEntries(body).length) {
    throw new LookupError(String(body.error).slice(0, 200), { status: 503, detail: body.error });
  }

  const entries = extractEntries(body);
  const total = Number(body.total ?? entries.length) || entries.length;
  const hits = entries.slice(0, MAX_HITS).map((entry) => toHit(entry, kind));

  return {
    hits,
    // Grouping is computed from the hits already fetched, so the panel costs
    // nothing extra against the provider's credits.
    correlation: correlate(hits, input),
    total,
    truncated: total > MAX_HITS,
    // Surfaced so the credit balance is visible instead of a silent surprise
    // when a search suddenly stops working.
    balance: Number.isFinite(body.balance) ? body.balance : null,
  };
}
