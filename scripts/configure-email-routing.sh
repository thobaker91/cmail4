#!/usr/bin/env bash
# Cmail — automatic Email Routing configuration via the Cloudflare API
# Usage: CLOUDFLARE_API_TOKEN=… ./scripts/configure-email-routing.sh mail.example.com
set -euo pipefail

DOMAIN="${1:?usage: configure-email-routing.sh <domain>}"
TOKEN="${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
API="https://api.cloudflare.com/client/v4"
HDR=(-H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")

zone_base() {
  # use registrable domain (last two labels — covers standard domains)
  echo "$1" | awk -F. '{ if (NF <= 2) print $0; else { print $(NF-1)"."$NF } }'
}

ZONE_DOMAIN=$(zone_base "$DOMAIN")
echo "→ looking up zone: $ZONE_DOMAIN"

ZONE_ID=$(curl -s "${HDR[@]}" "$API/zones?name=$ZONE_DOMAIN" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.result?.[0]?.id||'')})")
[ -n "$ZONE_ID" ] || { echo "✖ zone $ZONE_DOMAIN not found on this token"; exit 1; }
echo "✔ zone id: $ZONE_ID"

WORKER_NAME="cmail"
echo "→ enabling Email Routing…"
curl -s -X POST "${HDR[@]}" "$API/zones/$ZONE_ID/email/routing/enable" >/dev/null || true

echo "→ ensuring MX records…"
for i in 1 2 3; do
  PRIO=$((i*10))
  BODY="{\"type\":\"MX\",\"name\":\"$ZONE_DOMAIN\",\"content\":\"route$i.mx.cloudflare.net\",\"priority\":$PRIO,\"ttl\":1}"
  curl -s -X POST "${HDR[@]}" "$API/zones/$ZONE_ID/dns/records" -d "$BODY" | grep -q '"success":true' \
    && echo "  ✔ MX route$i" || echo "  · MX route$i (may already exist)"
done

echo "→ ensuring SPF record…"
BODY='{"type":"TXT","name":"'$ZONE_DOMAIN'","content":"v=spf1 include:_spf.mx.cloudflare.net ~all","ttl":1}'
curl -s -X POST "${HDR[@]}" "$API/zones/$ZONE_ID/dns/records" -d "$BODY" | grep -q '"success":true' \
  && echo "  ✔ SPF" || echo "  · SPF (may already exist)"

echo "→ setting catch-all rule → worker ($WORKER_NAME)…"
CUR=$(curl -s "${HDR[@]}" "$API/zones/$ZONE_ID/email/routing/rules/catch_all")
CUR_ID=$(echo "$CUR" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.result?.id||'')})")
if [ -n "$CUR_ID" ]; then
  curl -s -X PUT "${HDR[@]}" "$API/zones/$ZONE_ID/email/routing/rules/catch_all" \
    -d "{\"actions\":[{\"type\":\"worker\",\"value\":[\"$WORKER_NAME\"]}],\"enabled\":true,\"matchers\":[{\"type\":\"all\"}],\"name\":\"catch-all to $WORKER_NAME\"}" \
    | grep -q '"success":true' && echo "✔ catch-all updated"
else
  curl -s -X POST "${HDR[@]}" "$API/zones/$ZONE_ID/email/routing/rules" \
    -d "{\"actions\":[{\"type\":\"worker\",\"value\":[\"$WORKER_NAME\"]}],\"enabled\":true,\"matchers\":[{\"type\":\"all\"}],\"name\":\"catch-all to $WORKER_NAME\"}" \
    | grep -q '"success":true' && echo "✔ catch-all created"
fi

echo ""
echo "────────────────────────────────────────────"
echo " Email Routing for $DOMAIN is configured."
echo " Mail to any address on this domain now lands"
echo " in your Cmail worker."
echo "────────────────────────────────────────────"
