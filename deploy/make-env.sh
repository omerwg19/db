#!/usr/bin/env bash
# Creates /etc/veriscope.env with generated secrets.
set -euo pipefail

ENV_FILE=/etc/veriscope.env

if [[ -f "$ENV_FILE" ]]; then
  echo "$ENV_FILE already exists. Edit it directly instead of regenerating;"
  echo "regenerating QUERY_DIGEST_PEPPER invalidates nothing but should be deliberate."
  exit 1
fi

DOMAIN="${1:-}"
if [[ -z "$DOMAIN" ]]; then
  echo "usage: $0 your-domain.com" >&2
  exit 1
fi

read -rsp "Generate secrets now? [Y/n] " ans
if [[ "${ans,,}" == "n" ]]; then
  echo "Aborted; no file written." >&2
  exit 1
fi

pepper="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" 2>/dev/null || head -c 32 /dev/urandom | xxd -p -c 64)"

umask 077
cat > "$ENV_FILE" <<EOF
# Veriscope runtime configuration. mode 600, owned by root.
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
PUBLIC_ORIGIN=https://${DOMAIN}
# Leave unset only if no transactional mail is wired up; reset/verify links
# are then written to the journal instead of emailed.
MAIL_WEBHOOK=
# Random per deployment. Salts the non-reversible query digests.
QUERY_DIGEST_PEPPER=${pepper}
# Cookies are Secure by default; do not set this to 0 in production.
SECURE_COOKIES=1
EOF

echo "Wrote $ENV_FILE"
echo "Next: set MAIL_WEBHOOK if you want real reset/verify email."