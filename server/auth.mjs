// Auth layer: SQLite-backed accounts and sessions, scrypt password hashing,
// CSRF tokens and per-IP rate limiting. No external dependencies.
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// Salts the non-reversible query digests. Set QUERY_DIGEST_PEPPER in the
// deployment environment. If it is missing we still boot - a random per-process
// key is used instead, which keeps digests one-way but leaves them guessable by
// anyone holding a copy of the database. Failing hard here would take the whole
// site offline, which is worse than the weaker digest.
const CONFIGURED_PEPPER = String(process.env.QUERY_DIGEST_PEPPER ?? "").trim();
const DIGEST_PEPPER =
  CONFIGURED_PEPPER ||
  (() => {
    console.warn(
      "[warn] QUERY_DIGEST_PEPPER is not set. Falling back to a random per-process " +
        "key. Set QUERY_DIGEST_PEPPER in the environment to protect query digests " +
        "against a leaked-database dictionary attack."
    );
    return randomBytes(32).toString("hex");
  })();

const PLANS = {
  free: { label: "Free", dailyQuota: 10, priceUsd: 0, periodDays: 0 },
  pro: { label: "Pro", dailyQuota: 500, priceUsd: 10, periodDays: 30 },
  // Sold by hand, not through self-serve checkout.
  enterprise: { label: "Enterprise", dailyQuota: 15000, priceUsd: null, periodDays: 0 },
};

// Plans a customer can buy themselves, mapped to the provider price id. The
// amount is settled in the provider's request, never trusted from the client.
const CHECKOUT_PLANS = {
  pro: { providerPriceId: null, amountUsd: 10 },
};

export class Auth {
  // DB_PATH lets the database live on a mounted persistent volume, which is
  // what container platforms require. Without it every redeploy wipes accounts.
  constructor(
    dbPath = String(process.env.DB_PATH ?? "").trim() || join(root, "data", "veriscope.db")
  ) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.attempts = new Map();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        email        TEXT    NOT NULL UNIQUE,
        password     TEXT    NOT NULL,
        name         TEXT    NOT NULL DEFAULT '',
        plan         TEXT    NOT NULL DEFAULT 'free',
        verified     INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
        last_login   TEXT
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash   TEXT    PRIMARY KEY,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        csrf         TEXT    NOT NULL,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        user_agent   TEXT,
        ip           TEXT
      );

      CREATE TABLE IF NOT EXISTS queries (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        kind         TEXT    NOT NULL,
        input_digest TEXT    NOT NULL,
        hits         INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_tokens (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        purpose      TEXT    NOT NULL,
        token_hash   TEXT    NOT NULL UNIQUE,
        created_at   INTEGER NOT NULL,
        expires_at   INTEGER NOT NULL,
        used_at      INTEGER
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        email        TEXT,
        event        TEXT    NOT NULL,
        detail       TEXT,
        ip           TEXT,
        user_agent   TEXT,
        created_at   INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user  ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_queries_user  ON queries(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_queries_time  ON queries(created_at);
      CREATE INDEX IF NOT EXISTS idx_tokens_hash    ON auth_tokens(token_hash);
      CREATE INDEX IF NOT EXISTS idx_audit_user    ON audit_log(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_audit_time    ON audit_log(created_at);

      -- One row per provider payment attempt. provider_ref is UNIQUE, which is
      -- what makes the webhook safe to retry: a duplicate delivery hits the
      -- constraint instead of granting a second period of access.
      CREATE TABLE IF NOT EXISTS payments (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider      TEXT    NOT NULL,
        provider_ref  TEXT    NOT NULL UNIQUE,
        invoice_ref   TEXT,
        plan          TEXT    NOT NULL,
        amount_usd    REAL    NOT NULL,
        currency      TEXT,
        crypto        TEXT,
        status        TEXT    NOT NULL DEFAULT 'pending',
        period_days   INTEGER NOT NULL DEFAULT 30,
        created_at    INTEGER NOT NULL,
        paid_at       INTEGER,
        raw           TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id, created_at DESC);
    `);

    // Subscriptions are prepaid periods, so paid access needs an expiry. Added
    // separately because existing databases already have a users table.
    if (
      !this.db
        .prepare("PRAGMA table_info(users)")
        .all()
        .some((c) => c.name === "plan_expires_at")
    ) {
      this.db.exec("ALTER TABLE users ADD COLUMN plan_expires_at INTEGER");
    }

    // Early local builds persisted the raw search string. Drop it on sight and
    // rebuild with the digest-only shape: what was searched must never persist.
    if (
      this.db
        .prepare("PRAGMA table_info(queries)")
        .all()
        .some((c) => c.name === "input")
    ) {
      this.db.exec("DROP TABLE queries");
      this.db.exec(`CREATE TABLE queries (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
        kind         TEXT    NOT NULL,
        input_digest TEXT    NOT NULL,
        hits         INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL
      )`);
    }
  }

  /* ---------------------------------------------------------- passwords -- */
  hashPassword(password) {
    const salt = randomBytes(16);
    const key = scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
  }

  verifyPassword(password, stored) {
    try {
      const [scheme, N, r, p, saltB64, keyB64] = stored.split("$");
      if (scheme !== "scrypt") return false;
      const salt = Buffer.from(saltB64, "base64");
      const expected = Buffer.from(keyB64, "base64");
      const actual = scryptSync(password, salt, expected.length, {
        N: Number(N), r: Number(r), p: Number(p),
      });
      return timingSafeEqual(actual, expected);
    } catch {
      return false;
    }
  }

  /* ----------------------------------------------------- rate limiting -- */
  checkRate(bucket, key, limit, windowMs) {
    const now = Date.now();
    const id = `${bucket}:${key}`;
    const hits = (this.attempts.get(id) ?? []).filter((t) => now - t < windowMs);
    if (hits.length >= limit) {
      this.attempts.set(id, hits);
      const retry = Math.ceil((windowMs - (now - hits[0])) / 1000);
      return { ok: false, retryAfter: retry };
    }
    hits.push(now);
    this.attempts.set(id, hits);
    if (this.attempts.size > 5000) this.sweep(now);
    return { ok: true };
  }

  sweep(now) {
    for (const [id, hits] of this.attempts) {
      if (!hits.some((t) => now - t < 3_600_000)) this.attempts.delete(id);
    }
  }

  /* ------------------------------------------------------------- users -- */
  createUser({ email, password, name, plan = "free" }) {
    const normalised = String(email).trim().toLowerCase();
    const exists = this.db
      .prepare("SELECT id FROM users WHERE email = ?")
      .get(normalised);
    if (exists) throw Object.assign(new Error("email_taken"), { code: "email_taken" });

    const info = this.db
      .prepare(
        "INSERT INTO users (email, password, name, plan) VALUES (?, ?, ?, ?)"
      )
      .run(normalised, this.hashPassword(password), String(name ?? "").trim(), plan);

    return this.getUserById(Number(info.lastInsertRowid));
  }

  getUserById(id) {
    const row = this.db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(id);
    return row ? this.publicUser(row) : null;
  }

  getUserRowByEmail(email) {
    return this.db
      .prepare("SELECT * FROM users WHERE email = ?")
      .get(String(email).trim().toLowerCase());
  }

  // Access is a prepaid period, not a permanent flag. Once plan_expires_at
  // passes the account reverts to free until the next payment is applied, so
  // there is no background job needed to expire subscriptions.
  effectivePlan(row) {
    if (!row || row.plan === "free" || !PLANS[row.plan]) return "free";
    if (row.plan_expires_at && row.plan_expires_at <= Date.now()) return "free";
    return row.plan;
  }

  publicUser(row) {
    const key = this.effectivePlan(row);
    const plan = PLANS[key] ?? PLANS.free;
    return {
      id: row.id,
      email: row.email,
      name: row.name,
      plan: key,
      planLabel: plan.label,
      dailyQuota: plan.dailyQuota,
      planExpiresAt: row.plan_expires_at ?? null,
      verified: !!row.verified,
      createdAt: row.created_at,
    };
  }

  setPlan(userId, plan) {
    if (!PLANS[plan]) return this.getUserById(userId);
    this.db.prepare("UPDATE users SET plan = ? WHERE id = ?").run(plan, userId);
    return this.getUserById(userId);
  }

  /* ----------------------------------------------------------- payments -- */

  // Registers an invoice we handed out to the provider. Returns null when the
  // provider reference already exists so a retried request is a no-op.
  createPayment({ userId, provider, providerRef, invoiceRef, plan, amountUsd, periodDays }) {
    try {
      const info = this.db
        .prepare(
          `INSERT INTO payments
             (user_id, provider, provider_ref, invoice_ref, plan,
              amount_usd, status, period_days, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(userId, provider, providerRef, invoiceRef, plan, amountUsd, periodDays, Date.now());
      return info.lastInsertRowid;
    } catch (err) {
      if (String(err.message).includes("UNIQUE")) return null;
      throw err;
    }
  }

  getPaymentByRef(providerRef) {
    return this.db.prepare("SELECT * FROM payments WHERE provider_ref = ?").get(providerRef);
  }

  listPayments(userId) {
    return this.db
      .prepare("SELECT * FROM payments WHERE user_id = ? ORDER BY created_at DESC LIMIT 20")
      .all(userId)
      .map((p) => ({
        id: p.id,
        provider: p.provider,
        plan: p.plan,
        amountUsd: p.amount_usd,
        crypto: p.crypto,
        status: p.status,
        createdAt: p.created_at,
        paidAt: p.paid_at,
      }));
  }

  // Applies a confirmed payment. Idempotent on payment id: the UNIQUE
  // provider_ref constraint means NOWPayments retrying a webhook delivery will
  // not grant a second 30 days. Renewals stack onto whatever is left, so
  // paying early extends rather than discards the current period.
  applyPayment(paymentId, { crypto = null, status = "finished", raw = null } = {}) {
    const row = this.db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId);
    if (!row) return null;
    if (row.status === "finished") return { user: this.getUserById(row.user_id), applied: false };

    const now = Date.now();
    const base = row.user_id ? this.db.prepare("SELECT plan, plan_expires_at FROM users WHERE id = ?").get(row.user_id) : null;
    const live = base && base.plan === row.plan && base.plan_expires_at && base.plan_expires_at > now;
    const from = live ? base.plan_expires_at : now;
    const expires = from + row.period_days * 86400000;

    this.db
      .prepare("UPDATE payments SET status = ?, crypto = ?, raw = ?, paid_at = ? WHERE id = ?")
      .run(status, crypto, raw ? JSON.stringify(raw).slice(0, 4000) : null, now, paymentId);
    this.db
      .prepare("UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?")
      .run(row.plan, expires, row.user_id);

    this.log("payment.applied", {
      userId: row.user_id,
      detail: `${row.plan} +${row.period_days}d until ${new Date(expires).toISOString()}`,
    });
    return { user: this.getUserById(row.user_id), applied: true };
  }

  // Refund/chargeback: revoke the period this payment bought rather than
  // silently leaving the account upgraded.
  revokePayment(paymentId, raw = null) {
    const row = this.db.prepare("SELECT * FROM payments WHERE id = ?").get(paymentId);
    if (!row) return null;
    this.db.prepare("UPDATE payments SET status = 'refunded', raw = ? WHERE id = ?").run(
      raw ? JSON.stringify(raw).slice(0, 4000) : null,
      paymentId
    );
    this.db
      .prepare("UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = ?")
      .run(row.user_id);
    this.log("payment.revoked", { userId: row.user_id, detail: `plan ${row.plan}` });
    return this.getUserById(row.user_id);
  }

  setVerified(userId, verified = true) {
    this.db
      .prepare("UPDATE users SET verified = ? WHERE id = ?")
      .run(verified ? 1 : 0, userId);
    return this.getUserById(userId);
  }

  deleteAccount(userId) {
    // Sessions and tokens cascade; queries are nulled out by the FK.
    this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  }

  /* ---------------------------------------------------------- sessions -- */
  createSession(userId, { userAgent = "", ip = "" } = {}, ttlMs) {
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const now = Date.now();
    const ttl = ttlMs ?? 1000 * 60 * 60 * 24 * 30;

    this.db
      .prepare(
        `INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at, user_agent, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(this.hashToken(token), userId, csrf, now, now + ttl, userAgent.slice(0, 200), ip);

    this.db
      .prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?")
      .run(userId);

    return { token, csrf, expiresAt: now + ttl };
  }

  hashToken(token) {
    return createHash("sha256").update(token).digest("hex");
  }

  getSession(token) {
    if (!token) return null;
    const row = this.db
      .prepare("SELECT * FROM sessions WHERE token_hash = ?")
      .get(this.hashToken(token));
    if (!row) return null;
    if (row.expires_at < Date.now()) {
      this.destroySession(token);
      return null;
    }
    return row;
  }

  getSessionUser(token) {
    const session = this.getSession(token);
    if (!session) return null;
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(session.user_id);
    return row ? { session, user: this.publicUser(row) } : null;
  }

  destroySession(token) {
    if (!token) return;
    this.db
      .prepare("DELETE FROM sessions WHERE token_hash = ?")
      .run(this.hashToken(token));
  }

  purgeExpired() {
    this.db
      .prepare("DELETE FROM sessions WHERE expires_at < ?")
      .run(Date.now());
  }

  /* ---------------------------------------------------------- activity -- */
  quotaUsed(userId) {
    const since = Date.now() - 1000 * 60 * 60 * 24;
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM queries WHERE user_id = ? AND created_at > ?")
      .get(userId, since);
    return row?.n ?? 0;
  }

  // Quota only needs a count. The search term is reduced to a keyed digest so
  // it cannot be recovered or dictionary-attacked later.
  recordQuery(userId, kind, input, hits = 0) {
    const digest = createHash("sha256")
      .update(`${userId}\u0000${DIGEST_PEPPER}\u0000${String(input).trim().toLowerCase()}`)
      .digest("hex");
    this.db
      .prepare(
        "INSERT INTO queries (user_id, kind, input_digest, hits, created_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(userId, kind, digest, hits, Date.now());
  }

  // Rows only need to outlive the 24h quota window.
  purgeOldQueries() {
    this.db
      .prepare("DELETE FROM queries WHERE created_at < ?")
      .run(Date.now() - 1000 * 60 * 60 * 24);
  }

  /* ------------------------------------------------------ audit trail -- */
  log(event, { userId = null, email = null, detail = null, ip = null, userAgent = null } = {}) {
    this.db
      .prepare(
        `INSERT INTO audit_log (user_id, email, event, detail, ip, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        userId,
        email ? String(email).slice(0, 254) : null,
        event,
        detail ? String(detail).slice(0, 300) : null,
        ip ? String(ip).slice(0, 64) : null,
        userAgent ? String(userAgent).slice(0, 200) : null,
        Date.now()
      );
  }

  recentAudit(userId, limit = 20) {
    return this.db
      .prepare(
        `SELECT event, detail, ip, user_agent, created_at
         FROM audit_log WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .all(userId, limit)
      .map((r) => ({
        event: r.event,
        detail: r.detail,
        ip: r.ip,
        userAgent: r.user_agent,
        at: r.created_at,
      }));
  }

  failedLoginsSince(email, sinceMs) {
    return (
      this.db
        .prepare(
          "SELECT COUNT(*) AS n FROM audit_log WHERE event = 'login.failed' AND email = ? AND created_at > ?"
        )
        .get(String(email).toLowerCase(), sinceMs)?.n ?? 0
    );
  }

  /* ------------------------------------------------ single-use tokens -- */
  // Used for password reset and email verification. Only the hash is stored,
  // tokens expire, and consuming one marks it used so it cannot be replayed.
  issueToken(userId, purpose, ttlMs) {
    const raw = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db
      .prepare(
        "INSERT INTO auth_tokens (user_id, purpose, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)"
      )
      .run(userId, purpose, this.hashToken(raw), now, now + ttlMs);
    // Opportunistic cleanup keeps the table from growing without a scheduler.
    this.db.prepare("DELETE FROM auth_tokens WHERE expires_at < ?").run(now);
    return raw;
  }

  consumeToken(raw, purpose) {
    if (!raw) return null;
    const row = this.db
      .prepare(
        "SELECT * FROM auth_tokens WHERE token_hash = ? AND purpose = ?"
      )
      .get(this.hashToken(raw), purpose);
    if (!row || row.used_at || row.expires_at < Date.now()) return null;
    this.db
      .prepare("UPDATE auth_tokens SET used_at = ? WHERE id = ?")
      .run(Date.now(), row.id);
    return row.user_id;
  }

  purgeOldAudit(retentionMs = 90 * 24 * 60 * 60 * 1000) {
    this.db
      .prepare("DELETE FROM audit_log WHERE created_at < ?")
      .run(Date.now() - retentionMs);
  }
}

export { PLANS, CHECKOUT_PLANS };