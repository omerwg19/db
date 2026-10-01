# Deploying bugatti.lol

## Read this first: which Spaceship product do you need?

Spaceship sells several hosting products. Only two can run this app, and
**Hyperlift is the recommended one** â€” no SSH, no systemd, no Caddy.

| Product | Fits this app? | Why |
|---|---|---|
| **Hyperlift** (containers from GitHub) | **Yes â€” recommended** | Has a persistent volume at `/home/node`, which is what SQLite needs. Deploys on git push. |
| **Starlightâ„¢ VM** (VPS) | Yes, more work | Full root, but you install Node, systemd and Caddy yourself. |
| **Standard / Alf Website**, **EasyWP**, **Web Hosting** (shared cPanel) | **No** | PHP/WordPress stack, MySQL only. No long-lived Node process, and SQLite needs a writable directory plus a supervisor. |
| **CDN** | Not hosting | Only caches and fronts an origin you already have. |

Your **domain stays at Spaceship** in every case. That part already works.

---

## Option A â€” Hyperlift (recommended)

### 1. Put the code on GitHub

The project must live in a GitHub repo. From the `site/` directory:

```bash
git init
git add .
git commit -m "bugatti.lol"
git branch -M main
git remote add origin https://github.com/YOU/bugatti.git
git push -u origin main
```

### 2. Create the app

Spaceship â†’ **Starlight Manager â†’ Hyperlift â†’ Create app**

- Application name: `bugatti-lol`
- GitHub repository: yours
- Branch: `main`
- **Dockerfile path:** `Dockerfile`
- Turn **Automatic builds** on if you want every push to go live

### 3. Set environment variables

In the app's environment settings:

| Variable | Value |
|---|---|
| `PORT` | `8080` â€” Hyperlift's default application port |
| `DB_PATH` | `/home/node/data/veriscope.db` (name is historical; keep it so existing data is found) |
| `PUBLIC_ORIGIN` | `https://your-domain.com` |
| `QUERY_DIGEST_PEPPER` | a long random string (generate one below) |
| `MAIL_WEBHOOK` | your mail provider's HTTP endpoint |
| `SECURE_COOKIES` | leave unset â€” `Secure` is the default |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **`DB_PATH` must stay under `/home/node`.** Hyperlift mounts the persistent
> volume there and wipes everything outside it on each deploy. This single
> variable is the difference between keeping your accounts and losing them.

### 3a. Prove your accounts survive a deploy

Do not assume this works. A database in the wrong place, or a volume that is not
actually attached, looks completely healthy right up until the first build after
the accounts exist, and then every account is gone with nothing in the logs to
explain it.

Check the store is really on the volume:

```bash
curl -s https://your-domain.com/api/health
```

```json
{"ok":true,"db":"ok","db_path":"/home/node/data/veriscope.db","db_persistent":true}
```

`db_persistent` is computed from `DB_PATH`, not hard-coded, so `false` means the
path is wrong and accounts will vanish on the next deploy. Fix it and restart.

Then run the real test, once, before you care about this:

1. Create an account.
2. Push a commit (or press Rebuild) and wait for the deploy to finish.
3. Sign in with that account.

If the sign-in fails, the volume is not surviving the build. In Hyperlift, open
the application's settings and confirm a persistent volume/disk is attached and
that it covers `/home/node`. The boot log states the resolved path, the row
counts, and a loud warning if the database is outside the volume:

```
Database: /home/node/data/veriscope.db (on the persistent volume)
  rows: 3 user(s), 2 session(s), 0 payment(s), oldest account 2026-09-30 11:02:41
  size: 57344 bytes
```

Comparing `rows:` between two deploys is the quickest way to see a database being
reset. Back the volume up before you need it: `deploy/backup.sh`.

### 3b. Crypto payments (optional)

Pro costs $10 for 30 days. Without these variables the checkout button is
disabled and no payment can be taken â€” the app never fakes a paid state.

| Variable | Value |
|---|---|
| `NOWPAYMENTS_API_KEY` | API key from the NOWPayments dashboard |
| `NOWPAYMENTS_IPN_SECRET` | the IPN/callback secret from the same dashboard |
| `CRYPTO_PAY_CURRENCY` | optional â€” leave unset so the buyer chooses their coin |
| `NOWPAYMENTS_SANDBOX` | `1` to use the sandbox API while testing |

Then add the callback URL in the NOWPayments dashboard:

```
https://your-domain.com/api/billing/webhook
```

Use the **sandbox** keys first: checkout then takes you to a test payment page
and no real funds move. Only switch to live keys once you have watched one
sandbox payment land and the account upgrade on its own.

How it behaves:

- Checkout creates an **invoice**, not a fixed deposit address, so the buyer
  picks their own coin (BTC, ETH, SOL, USDT and the rest) on the provider's
  page. Set `CRYPTO_PAY_CURRENCY=btc` to pin one coin instead â€” which is also
  what the direct-payment fallback uses if invoices are unavailable.
- Payout wallets (where the money lands) are separate and set in
  `Settings â†’ Payments â†’ Payout wallets`.
- The checkout amount is settled server-side at a fixed $10; it is never read
  from the browser.
- The webhook verifies NOWPayments' HMAC signature from the `x-nowpayments-sig`
  header, then re-reads the payment from their API before upgrading. A callback
  that cannot be confirmed leaves the account on Free.
- Underpayment is judged by comparing `actually_paid` with `pay_amount` â€” both
  in the same coin. Comparing a crypto amount against the USD price would read
  a full $10 paid as 0.00031 BTC as "short of $10" and refuse every payment.
  Where those figures are absent the provider's own `finished` status decides.
- A refused upgrade logs `billing.webhook.underpaid` with both figures, and the
  server prints the same line to stdout so `Manage â†’ Application logs` shows it.
- An invoice callback reports the underlying deposit's `payment_id` while our
  row is keyed on the invoice id, so the handler matches on either.
- `provider_ref` is unique, so a redelivered webhook cannot grant a second
  period.
- Access is a prepaid window: `users.plan_expires_at` is compared at read
  time, so a lapsed subscription drops to Free with no cron job, and a refund
  revokes the upgrade.

Crypto has no recurring billing, so nothing charges itself. Renewal is a new
payment, which the dashboard offers explicitly.

### 4. Attach the domain

Hyperlift provides built-in SSL and supports a custom domain. Add the domain to
the app, then point DNS at it in Spaceship's DNS editor (usually handled for you
by the custom-domain flow). Confirm with:

```bash
curl -I https://your-domain.com
```

### 5. Backups

Hyperlift's volume is the database. Snapshot it on a schedule with
`deploy/backup.sh` run from your own machine, or export the volume before any
large migration.

---

## Option B â€” Starlight VM (full control)

---

## 1. Provision the VM

In Spaceship: **Starlight Manager â†’ Create Virtual Machine**

- **Plan:** Standard 1 (1 vCPU / 2 GB / 25 GB NVMe) is plenty for a demo site.
- **OS:** Ubuntu 24.04 LTS (or Debian 12).
- Set a root password, and add an SSH key if you have one.
- Note the **public IP**.

> **SSH on Starlight is port 22022, not 22.** This trips everyone up.

```bash
ssh -p 22022 root@YOUR_VPS_IP
```

## 2. Install Node.js 22+ and Caddy

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs caddy
node -v   # must be >= 22.5; the app uses the built-in node:sqlite module
```

## 3. Push the app

From your machine (the `site/` directory of this project):

```bash
ssh -p 22022 root@YOUR_VPS_IP 'bash -s' < deploy/deploy.sh
```

## 4. Create the runtime config

On the server:

```bash
bash /srv/veriscope/deploy/make-env.sh your-domain.com
systemctl restart veriscope
```

This writes `/etc/veriscope.env` (mode 600) with a freshly generated
`QUERY_DIGEST_PEPPER` and your `PUBLIC_ORIGIN`.

### `MAIL_WEBHOOK` is the one thing left to decide

Password-reset and email-verification links need somewhere to go. The app POSTs
this JSON to the URL you set:

```json
{ "to": "user@example.com", "subject": "...", "text": "..." }
```

Point it at your transactional mail provider's HTTP API (Resend, Postmark,
Mailgun, SESâ€¦). If you leave it empty, links are written to the systemd journal
instead â€” fine for testing, **not** acceptable in production, because a user
could never recover their password.

## 5. TLS with Caddy

```bash
echo 'VERISCOPE_DOMAIN = your-domain.com' > /etc/caddy/caddy.env
cp /srv/veriscope/deploy/Caddyfile /etc/caddy/Caddyfile
# add the import at the top of /etc/caddy/Caddyfile:
#   import /etc/caddy/caddy.env
systemctl reload caddy
```

Caddy requests the certificate automatically. It only succeeds once DNS resolves,
so do step 6 first if the domain is not pointed yet.

## 6. Point the domain at the VM (in Spaceship)

Spaceship: **Domain Portfolio â†’ select your domain â†’ DNS**

Add:

| Type | Host | Value |
|---|---|---|
| `A` | `@` | your VPS IPv4 |
| `AAAA` | `@` | your VPS IPv6, *only if* the server has working IPv6 |
| `CNAME` | `www` | `@` |

Wait for propagation (`dig +short your-domain.com`), then confirm TLS:

```bash
curl -I https://your-domain.com
```

**Do not** proxy port 3000 publicly. The app binds `127.0.0.1` and Caddy is the
only thing that should reach it.

## 7. Backups

The SQLite file is the only state worth keeping.

```bash
bash /srv/veriscope/deploy/backup.sh
```

Schedule it:

```cron
17 3 * * * bash /srv/veriscope/deploy/backup.sh
```

---

## Operational notes

- **Rate limiting is in-memory**, so it resets on restart and is per-process. Fine
  for one instance; add Redis before running two.
- **SQLite** is fine to a few hundred concurrent users. Beyond that, move to Postgres.
- **Search results are synthetic.** There is no real breach or infostealer data source
  wired up. The UI labels this everywhere; keep those labels if you connect a real
  source later, and get the legal/compliance review done first.
- **Query text is never stored.** The app persists only a salted digest, so it can
  count against the daily quota without recording what was searched. Recent searches
  shown in the dashboard live in `localStorage` on the user's own device. This is what
  makes the privacy claims on `legal.html` true â€” don't reintroduce raw logging.
- Placeholder content still needs replacing before launch: statistics, source counts,
  pricing, testimonials, contact email addresses, and the "encrypted at rest" claim
  (there is currently no encryption at rest).