# Deploying Veriscope

## Read this first: which Spaceship product do you need?

Spaceship sells several hosting products. Only two can run this app, and
**Hyperlift is the recommended one** — no SSH, no systemd, no Caddy.

| Product | Fits this app? | Why |
|---|---|---|
| **Hyperlift** (containers from GitHub) | **Yes — recommended** | Has a persistent volume at `/home/node`, which is what SQLite needs. Deploys on git push. |
| **Starlight™ VM** (VPS) | Yes, more work | Full root, but you install Node, systemd and Caddy yourself. |
| **Standard / Alf Website**, **EasyWP**, **Web Hosting** (shared cPanel) | **No** | PHP/WordPress stack, MySQL only. No long-lived Node process, and SQLite needs a writable directory plus a supervisor. |
| **CDN** | Not hosting | Only caches and fronts an origin you already have. |

Your **domain stays at Spaceship** in every case. That part already works.

---

## Option A — Hyperlift (recommended)

### 1. Put the code on GitHub

The project must live in a GitHub repo. From the `site/` directory:

```bash
git init
git add .
git commit -m "Veriscope"
git branch -M main
git remote add origin https://github.com/YOU/veriscope.git
git push -u origin main
```

### 2. Create the app

Spaceship → **Starlight Manager → Hyperlift → Create app**

- Application name: `veriscope`
- GitHub repository: yours
- Branch: `main`
- **Dockerfile path:** `Dockerfile`
- Turn **Automatic builds** on if you want every push to go live

### 3. Set environment variables

In the app's environment settings:

| Variable | Value |
|---|---|
| `PORT` | `8080` — Hyperlift's default application port |
| `DB_PATH` | `/home/node/data/veriscope.db` |
| `PUBLIC_ORIGIN` | `https://your-domain.com` |
| `QUERY_DIGEST_PEPPER` | a long random string (generate one below) |
| `MAIL_WEBHOOK` | your mail provider's HTTP endpoint |
| `SECURE_COOKIES` | leave unset — `Secure` is the default |

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **`DB_PATH` must stay under `/home/node`.** Hyperlift mounts the persistent
> volume there and wipes everything outside it on each deploy. This single
> variable is the difference between keeping your accounts and losing them.

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

## Option B — Starlight VM (full control)

---

## 1. Provision the VM

In Spaceship: **Starlight Manager → Create Virtual Machine**

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
Mailgun, SES…). If you leave it empty, links are written to the systemd journal
instead — fine for testing, **not** acceptable in production, because a user
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

Spaceship: **Domain Portfolio → select your domain → DNS**

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
  makes the privacy claims on `legal.html` true — don't reintroduce raw logging.
- Placeholder content still needs replacing before launch: statistics, source counts,
  pricing, testimonials, contact email addresses, and the "encrypted at rest" claim
  (there is currently no encryption at rest).