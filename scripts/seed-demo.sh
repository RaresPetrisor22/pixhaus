#!/usr/bin/env bash
#
# Seeds the demo studio: one gallery, every photo in a folder, one share link.
#
# Drives the public API over HTTP, so the photos go through the real pipeline
# and the worker makes the real renditions. Nothing touches the database.
#
# The account has to exist and be verified already — register it through the
# UI with the invite code, click the link in the email, then run this.
#
# Usage:
#   DEMO_EMAIL=demo@pixhausapp.com DEMO_PASSWORD='...' \
#     scripts/seed-demo.sh https://pixhausapp.com [scripts/fixtures] ["Gallery title"]
#
# Re-seeding: delete the gallery in the UI and run it again.

set -euo pipefail

API=${1:-http://localhost:3000}
DIR=${2:-scripts/fixtures}
TITLE=${3:-Ana & Mihai — wedding}
EMAIL=${DEMO_EMAIL:?set DEMO_EMAIL}
PASSWORD=${DEMO_PASSWORD:?set DEMO_PASSWORD}
CLIENT=${DEMO_CLIENT_EMAIL:-demo-client@example.com}

COOKIES=$(mktemp)
trap 'rm -f "$COOKIES"' EXIT

json() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
fail() {
  echo "  FAILED: $1" >&2
  exit 1
}

shopt -s nullglob nocaseglob
PHOTOS=("$DIR"/*.jpg "$DIR"/*.jpeg "$DIR"/*.png "$DIR"/*.webp)
[ ${#PHOTOS[@]} -gt 0 ] || fail "no photos in $DIR"

echo "== 1. sign in =="
curl -sf -X POST "$API/api/auth/login" -c "$COOKIES" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null ||
  fail "login refused — does $EMAIL exist and is it verified?"
echo "  $EMAIL"

echo
echo "== 2. gallery =="
GALLERY=$(curl -sf -X POST "$API/api/galleries" -b "$COOKIES" -H 'content-type: application/json' \
  -d "{\"title\":\"$TITLE\"}" | json "d['id']")
echo "  $TITLE ($GALLERY)"

echo
echo "== 3. upload ${#PHOTOS[@]} photo(s) =="
for PHOTO in "${PHOTOS[@]}"; do
  case "${PHOTO,,}" in
    *.jpg | *.jpeg) TYPE=image/jpeg ;;
    *.png) TYPE=image/png ;;
    *.webp) TYPE=image/webp ;;
  esac
  SIZE=$(stat -c%s "$PHOTO")
  NAME=$(basename "$PHOTO")

  TICKET=$(curl -sf -X POST "$API/api/galleries/$GALLERY/uploads" -b "$COOKIES" \
    -H 'content-type: application/json' \
    -d "{\"filename\":\"$NAME\",\"size\":$SIZE,\"contentType\":\"$TYPE\"}")
  curl -sf -X PUT --upload-file "$PHOTO" -H "content-type: $TYPE" \
    "$(echo "$TICKET" | json "d['uploadUrl']")" >/dev/null ||
    fail "storage rejected $NAME — check the bucket's CORS and credentials"
  curl -sf -X POST "$API/api/uploads/$(echo "$TICKET" | json "d['assetId']")/finalize" \
    -b "$COOKIES" >/dev/null
  echo "  $NAME ($SIZE bytes)"
done

echo
echo "== 4. renditions =="
for _ in $(seq 1 300); do
  PAGE=$(curl -sf "$API/api/galleries/$GALLERY/assets?limit=100" -b "$COOKIES")
  READY=$(echo "$PAGE" | json "sum(1 for a in d['assets'] if a['status'] == 'ready')")
  FAILED=$(echo "$PAGE" | json "sum(1 for a in d['assets'] if a['status'] == 'failed')")
  printf '  ready %s/%s\r' "$READY" "${#PHOTOS[@]}"
  [ "$READY" = "${#PHOTOS[@]}" ] && break
  [ "$FAILED" != 0 ] && fail "the worker gave up on $FAILED photo(s) — docker compose logs worker"
  sleep 1
done
echo
[ "$READY" = "${#PHOTOS[@]}" ] || fail "still waiting on the worker after five minutes"

echo
echo "== 5. share link =="
LINK=$(curl -sf -X POST "$API/api/galleries/$GALLERY/grants" -b "$COOKIES" \
  -H 'content-type: application/json' \
  -d "{\"audienceEmail\":\"$CLIENT\",\"rights\":[\"view\",\"download\"],\"label\":\"Demo\",\"expiresAt\":\"$(date -u -d '+365 days' +%Y-%m-%dT%H:%M:%SZ)\"}" |
  json "d['token']")

echo "  $API/g/$LINK"
echo
echo "== done =="
echo "  Sign in at $API/login as $EMAIL, or open the link above as a client."
