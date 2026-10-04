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
//  1. Credential columns are dropped from every record rather than displayed.
//     DeHashed regularly hands back plaintext passwords from stealer logs.
//     Everything else in the row is shown as the source returned it, because
//     that is the exposure someone checking an account needs to see, and it
//     keeps the site from becoming a credential dispenser.
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

// Every non-credential field the source can return, with a display label.
// Ordered identity-first: a reader opening a result wants to recognise the
// person before they read the context, and DeHashed's records vary widely in
// which columns a given dataset happened to contain.
const DETAIL_FIELDS = [
  ["email", "Email"],
  ["username", "Username"],
  ["name", "Name"],
  ["phone", "Phone"],
  ["ip_address", "IP address"],
  ["address", "Street address"],
  ["city", "City"],
  ["state", "State"],
  ["zip", "Postcode"],
  ["country", "Country"],
  ["dob", "Date of birth"],
  ["gender", "Gender"],
  ["domain", "Domain"],
  ["url", "URL"],
  ["company", "Employer"],
  ["job_title", "Job title"],
  ["device_type", "Device"],
  ["os", "Operating system"],
  ["browser", "Browser"],
  ["user_agent", "User agent"],
  ["vin", "Vehicle ID"],
  ["latitude", "Latitude"],
  ["longitude", "Longitude"],
];

// Values are rendered as the source returned them. This is the finding --
// "this address was breached alongside this username, IP and employer" is what a
// reader can act on, where a list of column names is not. Passwords and password
// hashes are absent by design and are never read out of a record at all.
const CREDENTIAL_KEYS = new Set(["password", "hashed_password", "password_hash", "hash"]);

function detailsOf(entry) {
  const details = [];
  for (const [key, label] of DETAIL_FIELDS) {
    const raw = entry?.[key];
    if (Array.isArray(raw)) {
      // Datasets disagree on cardinality: some have one value per column, some
      // have a list. Both are shown rather than dropping what is present.
      const values = raw.filter((v) => typeof v === "string" && v.length);
      if (values.length) details.push({ label, value: values.join(", ") });
    } else if (typeof raw === "string" && raw.length) {
      details.push({ label, value: raw });
    }
  }
  // Anything the source returned that is not in the table above and is not a
  // credential still belongs on the card; a missed column is data loss.
  const known = new Set(DETAIL_FIELDS.map(([k]) => k));
  for (const [key, value] of Object.entries(entry || {})) {
    if (known.has(key) || CREDENTIAL_KEYS.has(key)) continue;
    if (key === "database_name" || key === "source" || key === "id" || key === "date") continue;
    if (key === "breach_date") continue;
    if (typeof value === "string" && value.length) {
      details.push({ label: humanise(key), value });
    } else if (Array.isArray(value) && value.some((v) => typeof v === "string" && v.length)) {
      details.push({ label: humanise(key), value: value.filter((v) => typeof v === "string" && v.length).join(", ") });
    }
  }
  return details;
}

function humanise(key) {
  return String(key).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function presentFields(entry) {
  return DETAIL_FIELDS.filter(([key]) => {
    const value = entry?.[key];
    return typeof value === "string" ? value.length > 0 : value != null;
  }).map(([, label]) => label);
}

// How much this record actually identifies someone. Credentials are not part of
// the calculation: the panel reports what the data shows about a person, and a
// row of identifiers is strong evidence on its own terms.
function confidenceOf(details) {
  if (details.length >= 4) return "high";
  if (details.length >= 2) return "medium";
  return "low";
}

function toHit(entry, kind) {
  const details = detailsOf(entry);
  const fields = presentFields(entry);
  return {
    source: entry?.database_name || entry?.source || "Unattributed source",
    kind,
    // DeHashed records carry the breach name far more reliably than its date,
    // so the date says what is actually known rather than inventing one.
    breached: entry?.date || entry?.breach_date || "Date not published",
    fields,
    details,
    confidence: confidenceOf(details),
  };
}

// What makes a breach record worth reading is that its fields travel together.
// A username here and a physical address there are usually the same person, and
// the combination is what lets an attacker confirm a target or fill in a blank on
// a form they already half-know. So the shared values are grouped across the
// result set rather than left to be eyeballed one card at a time.
const SHARED_STRENGTH = { "IP address": "high", Username: "high", Phone: "high", "Street address": "high", VIN: "high", Email: "medium", "User agent": "high", Name: "low", "Date of birth": "low", Domain: "low" };

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

  return {
    nodes,
    exposure: {
      breaches: hits.length,
      sourceCount: new Set(hits.map((h) => h.source)).size,
      // How much of the person each record actually exposes. A row with an
      // address, employer and device says far more than a bare email.
      fieldCount: hits.reduce((max, h) => Math.max(max, h.details.length), 0),
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
