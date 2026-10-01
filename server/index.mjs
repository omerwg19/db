// Static file server + JSON auth/search API. No external dependencies.
// Run: node server/index.mjs   (then open http://localhost:3000)
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, dirname, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { Auth } from "./auth.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(root, "public");
const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";
const COOKIE = "vs_session";

// Cookies are marked Secure unless explicitly overridden for local testing.
// Trimmed because `set VAR=0 && cmd` in cmd.exe yields a trailing space.
const COOKIE_SECURE = String(process.env.SECURE_COOKIES ?? "").trim();
const SECURE_COOKIES = COOKIE_SECURE === "1" || COOKIE_SECURE === "true" || COOKIE_SECURE === "";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const SHORT_SESSION_MS = 1000 * 60 * 60 * 12;
const RESET_TTL_MS = 1000 * 60 * 60;
const VERIFY_TTL_MS = 1000 * 60 * 60 * 24;

// Where to hand reset / verification links. In production this must be the
// public origin so the emailed link resolves to the live site.
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN ?? `http://${HOST}:${PORT}`;
const MAIL_WEBHOOK = process.env.MAIL_WEBHOOK ?? "";

const auth = new Auth();
auth.purgeExpired();
auth.purgeOldAudit();
auth.purgeOldQueries();
setInterval(() => {
  auth.purgeExpired();
  auth.purgeOldAudit();
  auth.purgeOldQueries();
}, 60 * 60 * 1000).unref();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".webm": "video/webm",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

/* ------------------------------------------------------------ helpers -- */
const json = (res, status, body, headers = {}) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    ...securityHeaders(),
    ...headers,
  });
  res.end(payload);
};

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionCookie(token, maxAgeSec) {
  const bits = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (SECURE_COOKIES) bits.push("Secure");
  return bits.join("; ");
}

function clearCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress ?? "unknown";
}

async function readBody(req, limit = 16 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("too_large"), { code: "too_large" });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("bad_json"), { code: "bad_json" });
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const PASSWORD_MIN = 10;

/* ------------------------------------------------------ security heads -- */
function securityHeaders() {
  const h = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "geolocation=(), microphone=(), camera=(), interest-cohort=()",
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self'",
      "connect-src 'self'",
    ].join("; "),
  };
  // Only meaningful once the site is actually served over TLS.
  if (SECURE_COOKIES) {
    h["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  }
  return h;
}

/* ---------------------------------------------------------------- mail -- */
// Fires a transactional-mail webhook if one is configured. Without it the
// link is logged instead, so local testing still works.
async function sendMail({ to, subject, text }) {
  const link = text.match(/https?:\/\/\S+/)?.[0] ?? "";
  if (!MAIL_WEBHOOK) {
    if (link) console.log(`[mail:no-webhook] to=${to} subject=${subject} link=${link}`);
    return { delivered: false, logged: true };
  }
  try {
    const res = await fetch(MAIL_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to, subject, text }),
      signal: AbortSignal.timeout(8000),
    });
    return { delivered: res.ok };
  } catch (err) {
    console.error("[mail] delivery failed:", err.message);
    return { delivered: false, error: true };
  }
}

function validatePassword(password) {
  if (password.length < PASSWORD_MIN) {
    return `Password must be at least ${PASSWORD_MIN} characters.`;
  }
  if (/^\d+$/.test(password)) return "Password cannot be only numbers.";
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password) || !/[^\w\s]/.test(password)) {
    return "Mix letters with at least one number and one symbol.";
  }
  return null;
}

function validateRegistration(body) {
  const email = String(body.email ?? "").trim().toLowerCase();
  const password = String(body.password ?? "");
  const name = String(body.name ?? "").trim();
  const confirm = String(body.confirmPassword ?? "");

if (!EMAIL_RE.test(email)) return "Enter a valid email address.";
  const problem = validatePassword(password);
  if (problem) return problem;
  if (confirm && confirm !== password) return "Passwords do not match.";
  if (name.length > 80) return "Name is too long.";
  return null;
}

/* -------------------------------------------------------------- search -- */
// Placeholder resolver. Returns synthetic, clearly-labelled demo hits so the
// dashboard has something to render. Swap this for the real upstream client.
function detectKind(input) {
  const v = input.trim();
  if (EMAIL_RE.test(v)) return "Email";
  if (/^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/.*)?$/i.test(v)) return "Domain";
  if (/^\+?[\d\s().-]{7,20}$/.test(v) && /\d/.test(v)) return "Phone";
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v) || /^[0-9a-f:]{6,}$/i.test(v)) return "IP";
  if (/^\d{17,20}$/.test(v)) return "Discord ID";
  if (/^[a-z0-9_.\- ]{2,40}$/i.test(v)) return "Username";
  return "Unknown";
}

const DEMO_SOURCES = [
  "Breach corpus A", "Breach corpus B", "Infostealer log 1",
  "Infostealer log 2", "Social profiles", "Public registry",
];

function demoHits(kind, input) {
  const seed = [...input].reduce((a, c) => (a + c.charCodeAt(0)) % 9973, 7);
  const count = kind === "Unknown" ? 0 : 2 + (seed % 6);
  return Array.from({ length: count }, (_, i) => {
    const s = (seed + i * 977) % 9999;
    const when = new Date(Date.UTC(2024 + (s % 2), s % 12, 1 + (s % 27)));
    return {
      source: DEMO_SOURCES[(s + i) % DEMO_SOURCES.length],
      kind,
      breached: when.toISOString().slice(0, 10),
      fields: ["email", "password hash", "username"].slice(0, 1 + (s % 3)),
      confidence: ["low", "medium", "high"][s % 3],
    };
  });
}

/* -------------------------------------------------------------- routes -- */
async function handleApi(req, res, url) {
  const route = `${req.method} ${url.pathname}`;
  const ip = clientIp(req);
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE];

  // ---- CSRF applies to every state-changing authenticated request.
  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) {
      return json(res, 403, { error: "Cross-origin request blocked." });
    }
  }

  /* ---- session introspection (used by the SPA-ish nav) ---- */
  if (route === "GET /api/me") {
    const found = auth.getSessionUser(token);
    if (!found) return json(res, 200, { user: null });
    return json(res, 200, {
      user: found.user,
      csrf: found.session.csrf,
      quotaUsed: auth.quotaUsed(found.user.id),
    });
  }

  /* ---- register ---- */
  if (route === "POST /api/register") {
    const limit = auth.checkRate("register", ip, 5, 60 * 60 * 1000);
    if (!limit.ok) {
      return json(res, 429, { error: "Too many accounts from this address. Try again later." },
        { "Retry-After": limit.retryAfter });
    }

    const body = await readBody(req);
    const problem = validateRegistration(body);
    if (problem) return json(res, 400, { error: problem });

    const existing = auth.getUserRowByEmail(body.email);
    if (existing) {
      return json(res, 409, { error: "An account with that email already exists." });
    }

    const user = auth.createUser({
      email: body.email,
      password: body.password,
      name: body.name,
    });
    const session = auth.createSession(user.id, {
      userAgent: req.headers["user-agent"] ?? "",
      ip,
    });
    auth.log("account.created", { userId: user.id, email: user.email, ip, userAgent: req.headers["user-agent"] });

    // Verification link. Delivered by webhook, or logged when none is set.
    const verify = auth.issueToken(user.id, "email_verify", VERIFY_TTL_MS);
    void sendMail({
      to: user.email,
      subject: "Confirm your Veriscope email",
      text: `Confirm your address: ${PUBLIC_ORIGIN}/verify.html?token=${verify}`,
    });

    return json(res, 201, { user }, {
      "Set-Cookie": sessionCookie(session.token, SESSION_TTL_MS / 1000),
    });
  }

  /* ---- login ---- */
  if (route === "POST /api/login") {
    const limit = auth.checkRate("login", ip, 10, 15 * 60 * 1000);
    if (!limit.ok) {
      return json(res, 429, { error: "Too many attempts. Wait a few minutes and try again." },
        { "Retry-After": limit.retryAfter });
    }

    const body = await readBody(req);
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    if (!email || !password) {
      return json(res, 400, { error: "Email and password are required." });
    }

    const row = auth.getUserRowByEmail(email);
    // Always run a hash so a missing account and a wrong password cost the same.
    const ok = row
      ? auth.verifyPassword(password, row.password)
      : auth.verifyPassword(password, auth.hashPassword("decoy-password-value"));

    if (!row || !ok) {
      auth.log("login.failed", {
        userId: row?.id ?? null,
        email,
        detail: "bad_credentials",
        ip,
        userAgent: req.headers["user-agent"],
      });
      return json(res, 401, { error: "Incorrect email or password." });
    }

    // Step up on accounts that have taken repeated failures recently.
    if (auth.failedLoginsSince(email, Date.now() - 15 * 60 * 1000) >= 5) {
      auth.checkRate("login_stepup", ip, 3, 15 * 60 * 1000);
    }

    const user = auth.publicUser(row);
    const ttl = body.remember === false ? SHORT_SESSION_MS : SESSION_TTL_MS;
    const session = auth.createSession(row.id, {
      userAgent: req.headers["user-agent"] ?? "",
      ip,
    }, ttl);
    auth.log("login.ok", {
      userId: row.id,
      email,
      ip,
      userAgent: req.headers["user-agent"],
    });
    return json(res, 200, { user }, {
      "Set-Cookie": sessionCookie(session.token, SESSION_TTL_MS / 1000),
    });
  }

  /* ---- logout ---- */
  if (route === "POST /api/logout") {
    const found = auth.getSessionUser(token);
    if (found && req.headers["x-csrf-token"] !== found.session.csrf) {
      return json(res, 403, { error: "Invalid CSRF token." });
    }
    if (found) auth.log("logout", { userId: found.user.id, email: found.user.email, ip });
    auth.destroySession(token);
    return json(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });
  }

  /* ---- request a password reset link ---- */
  if (route === "POST /api/password/forgot") {
    const limit = auth.checkRate("forgot", ip, 5, 60 * 60 * 1000);
    if (!limit.ok) {
      return json(res, 429, { error: "Too many requests. Try again later." },
        { "Retry-After": limit.retryAfter });
    }
    const body = await readBody(req);
    const email = String(body.email ?? "").trim().toLowerCase();

    // Always answer the same way: confirming an address exists is itself a leak.
    const generic = { ok: true };
    if (!EMAIL_RE.test(email)) return json(res, 200, generic);

    const row = auth.getUserRowByEmail(email);
    if (!row) return json(res, 200, generic);

    const token = auth.issueToken(row.id, "password_reset", RESET_TTL_MS);
    auth.log("password.reset_requested", { userId: row.id, email, ip });
    const sent = await sendMail({
      to: email,
      subject: "Reset your Veriscope password",
      text: `Reset your password (valid 60 minutes): ${PUBLIC_ORIGIN}/reset.html?token=${token}\nIf you did not request this, ignore this email.`,
    });
    return json(res, 200, sent.delivered ? generic : { ...generic, devLink: `${PUBLIC_ORIGIN}/reset.html?token=${token}` });
  }

  /* ---- complete a password reset ---- */
  if (route === "POST /api/password/reset") {
    const limit = auth.checkRate("reset", ip, 10, 60 * 60 * 1000);
    if (!limit.ok) {
      return json(res, 429, { error: "Too many attempts. Try again later." },
        { "Retry-After": limit.retryAfter });
    }
    const body = await readBody(req);
    const next = String(body.newPassword ?? "");
    const problem = validatePassword(next);
    if (problem) return json(res, 400, { error: problem });

    const userId = auth.consumeToken(String(body.token ?? ""), "password_reset");
    if (!userId) return json(res, 400, { error: "That reset link is invalid or has expired." });

    auth.db
      .prepare("UPDATE users SET password = ? WHERE id = ?")
      .run(auth.hashPassword(next), userId);
    // Force every existing session to re-authenticate after a credential change.
    auth.db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    auth.log("password.reset_completed", { userId, ip });

    return json(res, 200, { ok: true });
  }

  /* ---- email verification ---- */
  if (route === "POST /api/verify") {
    const body = await readBody(req);
    const userId = auth.consumeToken(String(body.token ?? ""), "email_verify");
    if (!userId) return json(res, 400, { error: "That confirmation link is invalid or has expired." });
    auth.setVerified(userId, true);
    auth.log("email.verified", { userId, ip });
    return json(res, 200, { ok: true });
  }

  /* ---- resend a verification link ---- */
  if (route === "POST /api/verify/resend") {
    const found = auth.getSessionUser(token);
    if (!found) return json(res, 401, { error: "Sign in to continue." });
    if (found.user.verified) return json(res, 200, { ok: true });
    const link = auth.issueToken(found.user.id, "email_verify", VERIFY_TTL_MS);
    await sendMail({
      to: found.user.email,
      subject: "Confirm your Veriscope email",
      text: `Confirm your address: ${PUBLIC_ORIGIN}/verify.html?token=${link}`,
    });
    return json(res, 200, { ok: true });
  }

  /* ---- account deletion ---- */
  if (route === "POST /api/account/delete") {
    const found = auth.getSessionUser(token);
    if (!found) return json(res, 401, { error: "Sign in to continue." });
    if (req.headers["x-csrf-token"] !== found.session.csrf) {
      return json(res, 403, { error: "Invalid CSRF token." });
    }
    const body = await readBody(req);
    const row = auth.db
      .prepare("SELECT password FROM users WHERE id = ?")
      .get(found.user.id);
    if (!row || !auth.verifyPassword(String(body.password ?? ""), row.password)) {
      auth.log("account.delete_denied", { userId: found.user.id, email: found.user.email, ip });
      return json(res, 403, { error: "Password is incorrect." });
    }
    auth.log("account.deleted", { userId: found.user.id, email: found.user.email, ip });
    auth.deleteAccount(found.user.id);
    auth.destroySession(token);
    return json(res, 200, { ok: true }, { "Set-Cookie": clearCookie() });
  }

  /* ---- recent security activity (own account) ---- */
  if (route === "GET /api/activity") {
    const found = auth.getSessionUser(token);
    if (!found) return json(res, 401, { error: "Sign in to continue." });
    return json(res, 200, { activity: auth.recentAudit(found.user.id, 25) });
  }

  /* ---- change password ---- */
  if (route === "POST /api/password") {
    const found = auth.getSessionUser(token);
    if (!found) return json(res, 401, { error: "Sign in to continue." });
    if (req.headers["x-csrf-token"] !== found.session.csrf) {
      return json(res, 403, { error: "Invalid CSRF token." });
    }

    const body = await readBody(req);
    const row = auth.db
      .prepare("SELECT password FROM users WHERE id = ?")
      .get(found.user.id);
    if (!auth.verifyPassword(String(body.currentPassword ?? ""), row.password)) {
      return json(res, 403, { error: "Current password is incorrect." });
    }

    const next = String(body.newPassword ?? "");
    const problem = validatePassword(next);
    if (problem) return json(res, 400, { error: problem });

    auth.db
      .prepare("UPDATE users SET password = ? WHERE id = ?")
      .run(auth.hashPassword(next), found.user.id);

    // Invalidate every other session, keep this one.
    const keep = auth.hashToken(token);
    auth.db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?")
      .run(found.user.id, keep);

    return json(res, 200, { ok: true });
  }

  /* ---- search (requires a session) ---- */
  if (route === "POST /api/search") {
    const found = auth.getSessionUser(token);
    if (!found) return json(res, 401, { error: "Sign in to run a search." });
    if (req.headers["x-csrf-token"] !== found.session.csrf) {
      return json(res, 403, { error: "Invalid CSRF token." });
    }

    const used = auth.quotaUsed(found.user.id);
    if (used >= found.user.dailyQuota) {
      return json(res, 429, {
        error: `Daily quota reached (${found.user.dailyQuota}). Resets at midnight UTC.`,
      });
    }

    const body = await readBody(req);
    const input = String(body.input ?? "").trim();
    if (!input || input.length > 200) {
      return json(res, 400, { error: "Enter an identifier to search for." });
    }

    const kind = detectKind(input);
    const hits = demoHits(kind, input);
    auth.recordQuery(found.user.id, kind, input, hits.length);

    return json(res, 200, {
      query: { input, kind, at: new Date().toISOString() },
      hits,
      quota: { used: used + 1, limit: found.user.dailyQuota },
      demo: true,
    });
  }

  return json(res, 404, { error: "Unknown endpoint." });
}

/* -------------------------------------------------------------- static -- */
async function serveStatic(res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith("/")) pathname += "index.html";

  const safe = normalize(pathname).replace(/^([/\\])+/, "");
  if (safe.includes("..")) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  let file = join(PUBLIC, safe);
  try {
    const info = await stat(file);
    if (info.isDirectory()) file = join(file, "index.html");
  } catch {
    // Unknown path -> 404 page
    const notFound = join(PUBLIC, "404.html");
    try {
      const body = await readFile(notFound);
      res.writeHead(404, { "Content-Type": MIME[".html"] }).end(body);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    }
    return;
  }

  try {
    const body = await readFile(file);
    const ext = extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] ?? "application/octet-stream",
      "Content-Length": body.length,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=86400",
      ...securityHeaders(),
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
  }
}

/* -------------------------------------------------------------- server -- */
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const started = process.hrtime.bigint();

  res.on("finish", () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    // Log auth outcomes and errors; static asset noise is left out.
    const sensitive = url.pathname.startsWith("/api/");
    if (sensitive || res.statusCode >= 400) {
      console.log(
        `${new Date().toISOString()} ${req.method} ${url.pathname} ${res.statusCode} ${ms.toFixed(1)}ms`
      );
    }
  });

  try {
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else await serveStatic(res, url);
  } catch (err) {
    if (err?.code === "too_large") return json(res, 413, { error: "Request too large." });
    if (err?.code === "bad_json") return json(res, 400, { error: "Malformed request." });
    console.error("unhandled:", err);
    if (!res.headersSent) json(res, 500, { error: "Internal server error." });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Veriscope running at http://${HOST}:${PORT}`);
  console.log(`Database: ${process.env.DB_PATH || join(root, "data", "veriscope.db")}`);
  console.log(
    `Config: public_origin=${PUBLIC_ORIGIN} secure_cookies=${SECURE_COOKIES} ` +
      `mail_webhook=${MAIL_WEBHOOK ? "set" : "unset (links go to logs)"} ` +
      `pepper=${process.env.QUERY_DIGEST_PEPPER ? "set" : "MISSING (random per process)"}`
  );
});