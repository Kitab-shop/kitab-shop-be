#!/usr/bin/env bash
#
# Kitab Shop API — deploy the current main onto this box.
#
# Backs up the database, fast-forwards the checkout, reinstalls dependencies
# and restarts the service. Roughly 3 seconds of downtime; Restart=always in
# the unit covers the gap.
#
# Usage, on the server:
#   cd /srv/kitab/kitab-shop-be && ./pull.sh
#
# ── Git credentials ────────────────────────────────────────────────────────
# This script does NOT contain a token, and no token should ever be committed
# to this repo. Authenticate the box ONCE, as the kitab user, and git handles
# every pull after that:
#
#   sudo -u kitab git config --global credential.helper store
#   sudo -u kitab tee /home/kitab/.git-credentials >/dev/null <<'CRED'
#   https://<username>:<token>@github.com
#   CRED
#   sudo chmod 600 /home/kitab/.git-credentials
#
# Use a FINE-GRAINED token limited to these two repositories with read-only
# Contents access, or a per-repo read-only deploy key. A classic ghp_ token
# grants write access to every repository on the account, which a deploy that
# only ever pulls has no use for.
#
# ── Why this never runs `git clean`, `reset --hard` or `checkout .` ────────
# uploads/ is tracked in this repo, and every image an admin uploads lands in
# it as an UNTRACKED file. Any of those commands would delete the live product
# catalogue with no undo. `git pull --ff-only` leaves untracked files alone,
# which is the only reason images survive a deploy.

set -euo pipefail

BOLD=$'\033[1m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; RESET=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "${BOLD}" "$*" "${RESET}"; }
ok()   { printf '    %s✓%s %s\n' "${GREEN}" "${RESET}" "$*"; }
warn() { printf '    %s!%s %s\n' "${YELLOW}" "${RESET}" "$*"; }
die()  { printf '\n%serror:%s %s\n' "${RED}" "${RESET}" "$*" >&2; exit 1; }

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE="${SERVICE:-kitab-api}"
API_PORT="${API_PORT:-3000}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/kitab}"

cd "${APP_DIR}"

step "Preflight"
[[ -f .env ]] || die ".env is missing. The unit boots from it — see .env.prod in the repo you deploy from."
command -v git >/dev/null || die "git not found"
command -v node >/dev/null || die "node not found"
# A dirty tracked file means someone edited code on the server. --ff-only would
# fail anyway; catching it here says why instead of printing a merge error.
if ! git diff --quiet; then
  git --no-pager diff --stat
  die "tracked files are modified on this box — commit or discard them deliberately, then re-run"
fi
ok "clean checkout, .env present"

step "Backing up the database first"
# The real rollback. Reverting code does not undo a migration, so this runs
# before anything changes.
if BACKUP_DIR="${BACKUP_DIR}" RETENTION_DAYS=14 ./scripts/backup-db.sh; then
  ok "dump written to ${BACKUP_DIR}"
else
  die "backup failed — refusing to deploy over a database with no fresh dump"
fi

step "Fetching"
BEFORE="$(git rev-parse HEAD)"
git pull --ff-only
AFTER="$(git rev-parse HEAD)"
if [[ "${BEFORE}" == "${AFTER}" ]]; then
  ok "already up to date at ${AFTER:0:8}"
else
  ok "${BEFORE:0:8} → ${AFTER:0:8}"
  git --no-pager log --oneline "${BEFORE}..${AFTER}" | sed 's/^/      /'
fi

step "Installing dependencies"
# ci, never install: install rewrites the lockfile and can resolve a different
# tree than the one that was tested.
npm ci --omit=dev
ok "node_modules matches the lockfile"

# uploads/static is committed, so this is a repair rather than a first fetch —
# cheap, and it catches a missing placeholder before customers do.
npm run assets:static >/dev/null 2>&1 && ok "static assets present" || warn "assets:static failed — placeholders may 404"

if git --no-pager diff --name-only "${BEFORE}..${AFTER}" 2>/dev/null | grep -q '^scripts/migrate-'; then
  warn "a migrate-* script changed in this range. Migrations are NOT run automatically —"
  warn "read the diff and run the one you need by hand."
fi

step "Restarting ${SERVICE}"
sudo systemctl restart "${SERVICE}"

# Poll rather than sleep-then-check: the app connects to mongo and calls
# ensureUploadDirs() before it listens, so the port is not up instantly.
for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 "http://127.0.0.1:${API_PORT}/health" >/dev/null 2>&1; then
    ok "healthy at ${AFTER:0:8}"
    printf '\n%sDeploy complete.%s\n\n' "${BOLD}" "${RESET}"
    exit 0
  fi
  sleep 1
done

printf '\n'
die "service did not answer /health within 30s. Inspect: journalctl -u ${SERVICE} -n 50 --no-pager"
