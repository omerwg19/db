#!/usr/bin/env bash
# Consistent SQLite backup using VACUUM INTO, safe to run while the app is live.
set -euo pipefail

APP_DIR="${APP_DIR:-/srv/veriscope}"
DB="$APP_DIR/data/veriscope.db"
DEST="${BACKUP_DIR:-/var/backups/veriscope}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$DEST/veriscope-$STAMP.db"

[[ -f "$DB" ]] || { echo "No database at $DB" >&2; exit 1; }

install -d -m 700 "$DEST"

node -e '
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(process.argv[1]);
  // SQLite string literals are single-quoted; escape any embedded quote.
  const target = process.argv[2].replace(/'"'"'/g, "'"''"'");
  db.exec(`VACUUM INTO '"'"'${target}'"'"'`);
  db.close();
' "$DB" "$OUT"

chmod 600 "$OUT"
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"

find "$DEST" -name 'veriscope-*.db' -type f -mtime "+$KEEP_DAYS" -delete
echo "Pruned backups older than $KEEP_DAYS days."