// External backup for a database that the platform throws away.
//
// Hyperlift rebuilds the container on every push and, on this account, discards
// /home/node along with it, so a database kept on the volume is gone after every
// deploy. Storing it inside the container cannot fix that: the container is the
// thing being destroyed. This copies the store somewhere that outlives the
// build and puts it back on the next boot.
//
// Two shapes of destination, both dependency-free because the image installs
// nothing and every extra dependency is paid for on each build:
//
//   BACKUP_KIND=http  a PUT/GET endpoint with a bearer token. Any small worker
//                     or function will do. Easiest to test, no signing.
//   BACKUP_KIND=s3    any S3-compatible bucket: Cloudflare R2, Backblaze B2,
//                     MinIO. Authenticated with a hand-rolled SigV4 signer.
//
// The database holds password hashes and live session tokens, so a backup is
// encrypted with AES-256-GCM using BACKUP_KEY before it leaves the process, and
// is refused rather than uploaded in the clear if that key is missing.

import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

const env = (name, fallback = "") => String(process.env[name] ?? "").trim() || fallback;

const MAGIC = Buffer.from("VSBK1");
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KDF_SALT = "bugatti.lol/backup/v1";
const TIMEOUT_MS = 30_000;

function passphrase() {
  const pass = env("BACKUP_KEY");
  if (!pass) return null;
  return createHash("sha256").update(`${KDF_SALT} ${pass}`).digest();
}

export function backupStatus() {
  const url = env("BACKUP_URL");
  const kind = env("BACKUP_KIND", "http").toLowerCase();
  const reasons = [];
  if (!url) reasons.push("BACKUP_URL is not set");
  if (!passphrase()) reasons.push("BACKUP_KEY is not set");
  if (kind !== "http" && kind !== "s3") reasons.push(`BACKUP_KIND must be http or s3, got ${kind}`);
  if (kind === "s3" && !env("BACKUP_BUCKET")) reasons.push("BACKUP_BUCKET is not set");
  return { enabled: reasons.length === 0, reasons, url, kind };
}

/* ------------------------------------------------------------ encryption -- */

function seal(plain) {
  const key = passphrase();
  if (!key) throw new Error("BACKUP_KEY is not set");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function open_(blob) {
  const key = passphrase();
  if (!key) throw new Error("BACKUP_KEY is not set");
  if (blob.length < MAGIC.length + IV_BYTES + TAG_BYTES || !blob.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("not a backup produced by this app");
  }
  let offset = MAGIC.length;
  const iv = blob.subarray(offset, (offset += IV_BYTES));
  const tag = blob.subarray(offset, (offset += TAG_BYTES));
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(offset)), decipher.final()]);
}

/* ------------------------------------------------------------------ sigv4 -- */

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const sha256hex = (data) => createHash("sha256").update(data).digest("hex");

function signingKey(secret, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

function sigv4Headers({ method, url, body, accessKeyId, secretAccessKey, region, service = "s3" }) {
  const target = new URL(url);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256hex(body ?? Buffer.alloc(0));

  const canonicalHeaders = `host:${target.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = "host;x-amz-content-sha256;x-amz-date";

  const params = [...target.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const canonicalQuery = params.map(([k, v]) => [encodeURIComponent(k), encodeURIComponent(v)]);

  const canonicalRequest = [
    method,
    target.pathname.split("/").map(encodeURIComponent).join("/") || "/",
    canonicalQuery.map((p) => p.join("=")).join("&"),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256hex(canonicalRequest),
  ].join("\n");

  const signature = hmac(signingKey(secretAccessKey, dateStamp, region, service), stringToSign).toString("hex");

  return {
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payloadHash,
    authorization:
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/* -------------------------------------------------------------- transport -- */

async function send(method, url, { body, headers = {} } = {}) {
  return fetch(url, {
    method,
    body,
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });
}

async function getLatest() {
  const { url, kind } = backupStatus();
  const base = url.replace(/\/+$/, "");
  const target = `${base}/latest`;
  const init = { method: "GET" };

  if (kind === "s3") {
    Object.assign(init, {
      headers: sigv4Headers({
        method: "GET",
        url: target,
        accessKeyId: env("BACKUP_ACCESS_KEY_ID"),
        secretAccessKey: env("BACKUP_SECRET_ACCESS_KEY"),
        region: env("BACKUP_REGION", "auto"),
      }),
    });
  } else if (env("BACKUP_TOKEN")) {
    init.headers = { authorization: `Bearer ${env("BACKUP_TOKEN")}` };
  }

  const res = await send("GET", target, init);
  if (!res.ok) throw new Error(`latest -> HTTP ${res.status}`);
  const key = (await res.text()).trim();
  if (!key || !/^[A-Za-z0-9._-]+$/.test(key)) throw new Error(`latest -> implausible object name ${JSON.stringify(key)}`);
  return { base, key, kind };
}

async function putObject(base, key, blob, kind) {
  const target = `${base}/${key}`;
  const init = { method: "PUT", body: blob };

  if (kind === "s3") {
    init.headers = {
      ...sigv4Headers({
        method: "PUT",
        url: target,
        body: blob,
        accessKeyId: env("BACKUP_ACCESS_KEY_ID"),
        secretAccessKey: env("BACKUP_SECRET_ACCESS_KEY"),
        region: env("BACKUP_REGION", "auto"),
      }),
      "content-type": "application/octet-stream",
    };
  } else {
    init.headers = env("BACKUP_TOKEN")
      ? { authorization: `Bearer ${env("BACKUP_TOKEN")}`, "content-type": "application/octet-stream" }
      : { "content-type": "application/octet-stream" };
  }

  const res = await send("PUT", target, init);
  if (!res.ok) throw new Error(`PUT ${key} -> HTTP ${res.status}`);
}

async function fetchObject(base, key, kind) {
  const target = `${base}/${key}`;
  const init = { method: "GET" };

  if (kind === "s3") {
    init.headers = sigv4Headers({
      method: "GET",
      url: target,
      accessKeyId: env("BACKUP_ACCESS_KEY_ID"),
      secretAccessKey: env("BACKUP_SECRET_ACCESS_KEY"),
      region: env("BACKUP_REGION", "auto"),
    });
  } else if (env("BACKUP_TOKEN")) {
    init.headers = { authorization: `Bearer ${env("BACKUP_TOKEN")}` };
  }

  const res = await send("GET", target, init);
  if (!res.ok) throw new Error(`GET ${key} -> HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/* ------------------------------------------------------------------- store -- */

function looksEmpty(dbPath) {
  if (dbPath === ":memory:" || !existsSync(dbPath)) return true;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const users = db.prepare("SELECT count(*) AS n FROM users").get()?.n ?? 0;
    const payments = db.prepare("SELECT count(*) AS n FROM payments").get()?.n ?? 0;
    return users === 0 && payments === 0;
  } catch {
    // Unreadable or half-written counts as empty so restore gets a chance to
    // replace it; a real store is never left in a state that throws here.
    return true;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

/**
 * Put the store back if this boot found nothing. Never overwrites a store that
 * has accounts: a healthy database must not be traded away for a stale backup.
 */
export async function restoreIfEmpty(dbPath, { log = console.log, warn = console.warn } = {}) {
  const status = backupStatus();
  if (!status.enabled) {
    log(`  backup: off (${status.reasons.join("; ")})`);
    return { restored: false, reason: "disabled" };
  }
  if (!looksEmpty(dbPath)) {
    log("  backup: local store already has data, not restoring");
    return { restored: false, reason: "local-not-empty" };
  }

  let pointer;
  try {
    pointer = await getLatest();
  } catch (err) {
    // A brand new site has nothing backed up yet. That is not an error.
    log(`  backup: nothing to restore (${err.message})`);
    return { restored: false, reason: "no-backup" };
  }

  try {
    const blob = await fetchObject(pointer.base, pointer.key, pointer.kind);
    const plain = open_(blob);

    // Prove the decrypted bytes really are a database before they replace the
    // live one. A wrong BACKUP_KEY fails here rather than at the first query.
    const tmp = join(dirname(dbPath), `.restore-${process.pid}`);
    await mkdir(dirname(dirname(dbPath)), { recursive: true });
    await writeFile(tmp, plain);

    const check = new DatabaseSync(tmp, { readOnly: true });
    let storeId;
    try {
      storeId = check.prepare("SELECT value FROM meta WHERE key = 'store_id'").get()?.value;
    } finally {
      check.close();
    }
    if (!storeId) throw new Error("restored file has no store_id");

    await rename(tmp, dbPath);
    log(`  backup: restored ${pointer.key} (store_id ${storeId})`);
    return { restored: true, storeId, key: pointer.key };
  } catch (err) {
    warn(`  backup: RESTORE FAILED (${err.message}). Starting empty.`);
    return { restored: false, reason: "restore-failed" };
  }
}

/* ------------------------------------------------------------------ upload -- */

export function createBackup({ log = console.log, warn = console.warn } = {}) {
  const status = backupStatus();
  const intervalMs = Math.max(15, Number(env("BACKUP_INTERVAL_SECONDS", "60"))) * 1000;
  // The platform destroys the container rather than politely asking, so a write
  // is pushed out after a few seconds instead of waiting for the next interval.
  // Waiting means an account created just before a rebuild is the one account
  // that never gets backed up, which is exactly the case that matters.
  const debounceMs = Math.max(1, Number(env("BACKUP_DEBOUNCE_SECONDS", "3"))) * 1000;

  let auth = null;
  let dirty = false;
  let timer = null;
  let debounce = null;
  let flushing = null;

  function snapshot() {
    // Folding the WAL into the main file first means the bytes we upload are one
    // consistent snapshot. Without this the upload can capture a half-written
    // transaction.
    try {
      auth.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch (err) {
      warn(`  backup: WAL checkpoint failed (${err.message})`);
    }
    return readFile(env("DB_PATH", join(process.cwd(), "data", "veriscope.db")));
  }

  async function flush(reason = "scheduled") {
    if (!status.enabled || !auth) return { skipped: true };
    if (flushing) return flushing;

    flushing = (async () => {
      const started = Date.now();
      try {
        const plain = await snapshot();
        const storeId = auth.storeStats().storeId ?? "unknown";
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const key = `veriscope-${storeId}-${stamp}.vdb`;
        const base = status.url.replace(/\/+$/, "");
        const blob = seal(plain);

        await putObject(base, key, blob, status.kind);
        // The pointer goes last, so a crash mid-upload can never point at a
        // blob that was never fully written.
        await putObject(base, "latest", Buffer.from(key), status.kind);

        const check = await getLatest();
        if (check.key !== key) throw new Error(`pointer is ${check.key}, expected ${key}`);

        dirty = false;
        const kb = Math.round(plain.length / 1024);
        log(`  backup: ${reason} -> ${key} (${kb} KiB, ${Date.now() - started} ms)`);
        return { key, bytes: plain.length };
      } catch (err) {
        // Backups are best effort. A failing endpoint must not take the site
        // down, and the next flush retries.
        warn(`  backup: upload failed (${err.message}); will retry`);
        return { error: err.message };
      } finally {
        flushing = null;
      }
    })();

    return flushing;
  }

  function schedule() {
    if (debounce || !dirty || !auth) return;
    debounce = setTimeout(() => {
      debounce = null;
      if (dirty) flush("after write");
    }, debounceMs);
    debounce.unref?.();
  }

  return {
    enabled: status.enabled,
    reasons: status.reasons,
    attach(store) {
      auth = store;
      if (!status.enabled) return;
      timer = setInterval(() => {
        if (dirty) flush("interval");
      }, intervalMs);
      // Hyperlift destroys the container on rebuild. This is the last chance to
      // get the current state out, so a scheduled flush is not enough.
      for (const signal of ["SIGTERM", "SIGINT"]) {
        process.on(signal, () => {
          flush(`on ${signal}`);
          setTimeout(() => process.exit(0), 500).unref();
        });
      }
    },
    markDirty() {
      dirty = true;
      schedule();
    },
    flush,
    async stop() {
      if (timer) clearInterval(timer);
      if (debounce) clearTimeout(debounce);
      await flush("shutdown");
    },
    status: () => backupStatus(),
  };
}
