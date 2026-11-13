#!/usr/bin/env bash
# ============================================================
#  Cmail — one-command Cloudflare installer
#  Creates the D1 database, applies migrations, sets secrets,
#  deploys the worker and (optionally) wires Email Routing.
# ============================================================
set -euo pipefail

BRAND='\033[1;36m'
OK='\033[1;32m'
ERR='\033[1;31m'
DIM='\033[2m'
R='\033[0m'

say()  { echo -e "${BRAND}▶${R} $1"; }
good() { echo -e "${OK}✔${R} $1"; }
fail() { echo -e "${ERR}✖ $1${R}"; exit 1; }

echo -e "${BRAND}"
cat <<'BANNER'
   ██████╗███╗   ███╗ █████╗ ██╗██╗
  ██╔════╝████╗ ████║██╔══██╗██║██║
  ██║     ██╔████╔██║███████║██║██║
  ██║     ██║╚██╔╝██║██╔══██║██║██║
  ╚██████╗██║ ╚═╝ ██║██║  ██║██║██║
   ╚═════╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝╚═╝
     Liquid-glass mail on Cloudflare
BANNER
echo -e "${R}"

# ---------- checks ----------
command -v node >/dev/null || fail "Node.js 18+ is required — install it from https://nodejs.org"
command -v npm  >/dev/null || fail "npm is required"
node -e 'process.exit(process.versions.node.split(".")[0] >= 18 ? 0 : 1)' || fail "Node.js 18+ required (found $(node -v))"

say "Installing dependencies…"
npm install --no-audit --no-fund >/dev/null 2>&1
good "dependencies ready"

# ---------- cloudflare auth ----------
say "Checking Cloudflare authentication…"
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  good "using CLOUDFLARE_API_TOKEN from environment"
else
  if ! npx wrangler whoami 2>/dev/null | grep -q "logged in\|You are logged in"; then
    echo -e "${DIM}A browser window will open for Cloudflare login…${R}"
    npx wrangler login || fail "Cloudflare login failed"
  fi
  npx wrangler whoami | sed 's/^/  /'
  good "authenticated with Cloudflare"
fi

# ---------- d1 ----------
DB_NAME="cmail-db"
say "Creating D1 database “${DB_NAME}”…"
CREATE_OUT=$(npx wrangler d1 create "$DB_NAME" 2>&1 || true)
DB_ID=$(echo "$CREATE_OUT" | grep -oE 'database_id *= *"[a-f0-9-]+"' | head -1 | grep -oE '[a-f0-9-]{36}' || true)

if [ -z "$DB_ID" ]; then
  if echo "$CREATE_OUT" | grep -q "already exists"; then
    say "Database exists — fetching its id…"
    DB_ID=$(npx wrangler d1 list 2>/dev/null | grep -E "${DB_NAME}" | grep -oE '[a-f0-9-]{36}' | head -1 || true)
  fi
fi
[ -n "$DB_ID" ] || fail "Could not create/find the D1 database. Output was:\n$CREATE_OUT"
good "D1 database: $DB_ID"

# write id into wrangler config (jsonc)
node - "$DB_ID" <<'NODE'
const fs = require('fs');
const f = 'wrangler.jsonc';
let s = fs.readFileSync(f, 'utf8');
if (s.includes('REPLACE_WITH_D1_ID')) {
  s = s.replace(/REPLACE_WITH_D1_ID/g, process.argv[2]);
} else {
  // the committed config ships without a database_id (that is what makes the
  // one-click Deploy button work — the button provisions its own D1) — the
  // installer writes the freshly created id in after the database name
  s = s.replace(/("database_name"\s*:\s*"cmail-db"\s*,?)/, `$1\n      "database_id": "${process.argv[2]}",`);
}
fs.writeFileSync(f, 'utf8' === 'utf8' ? s : s);
fs.writeFileSync(f, s);
NODE
good "wrangler.jsonc updated"

# ---------- migrations + secret ----------
say "Applying database migrations…"
npx wrangler d1 migrations apply "$DB_NAME" --remote
good "schema applied"
echo -e "${DIM}  (CLI users just got every table; dashboard users get a one-click\n   “Create tables automatically” button in the setup wizard instead.)${R}"

say "Setting APP_SECRET…"
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
  echo "$SECRET" | npx wrangler secret put APP_SECRET >/dev/null 2>&1 || true
else
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")
  echo "$SECRET" | npx wrangler secret put APP_SECRET || true
fi
good "APP_SECRET configured"

# ---------- deploy ----------
say "Deploying Cmail…"
DEPLOY_OUT=$(npx wrangler deploy 2>&1)
echo "$DEPLOY_OUT" | sed 's/^/  /'
WORKER_URL=$(echo "$DEPLOY_OUT" | grep -oE 'https://[a-z0-9.-]+\.workers\.dev' | head -1 || true)
[ -n "$WORKER_URL" ] || WORKER_URL="(check wrangler output above)"
good "deployed: $WORKER_URL"

# ---------- optional: auto Email Routing ----------
echo ""
say "Email Routing automation (optional)"
echo -e "${DIM}To receive mail, the domain must use Cloudflare DNS and Email Routing must be enabled.${R}"
read -r -p "Automatically configure Email Routing now? Needs CLOUDFLARE_API_TOKEN with zone/email perms [y/N]: " ANSWER || ANSWER="n"
if [[ "${ANSWER:-n}" =~ ^[Yy]$ ]]; then
  if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
    read -r -p "CLOUDFLARE_API_TOKEN: " TOKEN
    export CLOUDFLARE_API_TOKEN="$TOKEN"
  fi
  read -r -p "Domain to configure (e.g. mail.example.com): " DOMAIN
  bash scripts/configure-email-routing.sh "$DOMAIN" && good "Email Routing configured for $DOMAIN" \
    || echo -e "${ERR}automatic routing failed — follow the manual steps below${R}"
fi

echo ""
echo -e "${OK}──────────────────────────────────────────────────────${R}"
echo -e "  ${OK}Cmail is live at:${R} $WORKER_URL"
echo ""
echo -e "  ${BRAND}Next steps${R}"
echo -e "  1. Open the URL above — the setup wizard will guide you:"
echo -e "     database tables (one click) → admin account → domain → outgoing mail"
echo -e "  2. The wizard never touches a SQL console — the Init button creates"
echo -e "     every table and index automatically, and is safe to re-run."
echo ""
echo -e "  ${BRAND}Manual Email Routing (if skipped above)${R}"
echo -e "  • Cloudflare Dashboard → your domain → Email Routing"
echo -e "  • Enable Email Routing (MX + SPF records are added for you)"
echo -e "  • Routing → Catch-all address → Action: Send to Worker → ${BRAND}cmail${R}"
echo ""
echo -e "  ${BRAND}Useful commands${R}"
echo -e "  • live logs : ${DIM}npx wrangler tail${R}"
echo -e "  • redeploy  : ${DIM}npm run deploy${R}"
echo -e "${OK}──────────────────────────────────────────────────────${R}"
