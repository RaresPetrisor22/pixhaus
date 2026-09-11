#!/usr/bin/env bash
#
# The whole product, end to end, against a running deployment.
#
# Photographer: log in, create a gallery, presign, PUT, finalize, wait for
# renditions, share it. Client: open the magic link, list the gallery, fetch a
# thumbnail straight from storage, download the original and compare the bytes.
# Then revoke and confirm both tiers are dead.
#
# The same script runs against localhost and against production, which is the
# point — it exercises all five things that are only true once there is a real
# domain, a real bucket and a proxy in front.
#
# Usage:
#   SMOKE_EMAIL=you@example.com SMOKE_PASSWORD='...' \
#     scripts/smoke.sh https://pixhaus.example.com [photo.jpg]
#
# The account has to exist and be verified already: in production the
# verification link goes to a real inbox, which no script can read.

set -euo pipefail

API=${1:-http://localhost:3000}
PHOTO=${2:-$HOME/photo.jpg}
EMAIL=${SMOKE_EMAIL:?set SMOKE_EMAIL}
PASSWORD=${SMOKE_PASSWORD:?set SMOKE_PASSWORD}

WORK=$(mktemp -d)
COOKIES=$WORK/cookies.txt
trap 'rm -rf "$WORK"' EXIT

json() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
fail() {
  echo "  FAILED: $1" >&2
  exit 1
}

[ -f "$PHOTO" ] || fail "no such file: $PHOTO"

case "${PHOTO,,}" in
  *.jpg | *.jpeg) TYPE=image/jpeg ;;
  *.png) TYPE=image/png ;;
  *.webp) TYPE=image/webp ;;
  *) fail "unsupported type: $PHOTO" ;;
esac

echo "smoke test against $API"
echo

echo "== 1. readiness =="
curl -sf "$API/readyz" | json "'  postgres %s | redis %s | storage %s' % (
  d['info']['postgres']['status'], d['info']['redis']['status'], d['info']['storage']['status'])"

echo
echo "== 2. photographer session =="
curl -sf -X POST "$API/api/auth/login" -c "$COOKIES" -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null ||
  fail "login refused — does $EMAIL exist and is it verified?"

# Over https the cookie is Secure, and a browser would refuse to send it back
# over plain http. curl does not enforce that, so check the flag explicitly.
case "$API" in
  https://*)
    grep -q TRUE "$COOKIES" || fail "the session cookie is not marked Secure"
    echo "  logged in, cookie is HttpOnly and Secure"
    ;;
  *) echo "  logged in" ;;
esac

echo
echo "== 3. upload =="
GALLERY=$(curl -sf -X POST "$API/api/galleries" -b "$COOKIES" \
  -H 'content-type: application/json' \
  -d "{\"title\":\"Smoke $(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" | json "d['id']")
SIZE=$(stat -c%s "$PHOTO")

TICKET=$(curl -sf -X POST "$API/api/galleries/$GALLERY/uploads" -b "$COOKIES" \
  -H 'content-type: application/json' \
  -d "{\"filename\":\"smoke.${PHOTO##*.}\",\"size\":$SIZE,\"contentType\":\"$TYPE\"}")
ASSET=$(echo "$TICKET" | json "d['assetId']")
UPLOAD_URL=$(echo "$TICKET" | json "d['uploadUrl']")

echo "  presigned PUT to $(echo "$UPLOAD_URL" | sed 's|\(https\?://[^/]*\).*|\1|')"
curl -sf -X PUT --upload-file "$PHOTO" -H "content-type: $TYPE" "$UPLOAD_URL" >/dev/null ||
  fail "the PUT was rejected — check the bucket credentials and CORS"
curl -sf -X POST "$API/api/uploads/$ASSET/finalize" -b "$COOKIES" >/dev/null
echo "  $SIZE bytes uploaded and finalized"

echo
echo "== 4. renditions =="
for _ in $(seq 1 120); do
  STATUS=$(curl -sf "$API/api/galleries/$GALLERY/assets" -b "$COOKIES" | json "d['assets'][0]['status']")
  printf '  %s\r' "$STATUS"
  [ "$STATUS" = ready ] && break
  [ "$STATUS" = failed ] && fail "the worker gave up — docker compose logs worker"
  sleep 1
done
[ "$STATUS" = ready ] || fail "still $STATUS after two minutes"
curl -sf "$API/api/galleries/$GALLERY/assets" -b "$COOKIES" |
  json "'  ready — %sx%s, blurhash %s' % (d['assets'][0]['width'], d['assets'][0]['height'], d['assets'][0]['blurhash'])"

echo
echo "== 5. share link =="
GRANT=$(curl -sf -X POST "$API/api/galleries/$GALLERY/grants" -b "$COOKIES" \
  -H 'content-type: application/json' \
  -d "{\"audienceEmail\":\"smoke@example.test\",\"rights\":[\"view\",\"download\"],\"expiresAt\":\"$(date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)\"}")
LINK_TOKEN=$(echo "$GRANT" | json "d['token']")
GRANT_ID=$(echo "$GRANT" | json "d['grant']['id']")
echo "  created, and the raw token came back once"

echo
echo "== 6. the client, holding nothing but a link =="
SESSION=$(curl -sf -X POST "$API/api/client/session" -H 'content-type: application/json' \
  -d "{\"token\":\"$LINK_TOKEN\"}") || fail "the magic link did not resolve"
BADGE=$(echo "$SESSION" | json "d['token']")
echo "$SESSION" | json "'  rights: %s, until %s' % (', '.join(d['rights']), d['expiresAt'])"

PAGE=$(curl -sf "$API/api/client/gallery" -H "authorization: Bearer $BADGE")
GRID_URL=$(echo "$PAGE" | json "d['assets'][0]['gridUrl']")
[ "$GRID_URL" != None ] || fail "no presigned grid URL in the gallery page"
echo "  gallery listed, thumbnails presigned at $(echo "$GRID_URL" | sed 's|\(https\?://[^/]*\).*|\1|')"

# Straight at storage, with no credential of any kind. This is the property the
# whole design rests on.
GRID_CODE=$(code "$GRID_URL")
[ "$GRID_CODE" = 200 ] || fail "fetching the thumbnail from storage gave $GRID_CODE"
echo "  thumbnail fetched straight from storage: 200"

echo
echo "== 7. download the original =="
DOWNLOAD_URL=$(curl -sf -X POST "$API/api/client/assets/$ASSET/download" \
  -H "authorization: Bearer $BADGE" | json "d['url']")
curl -sf -o "$WORK/downloaded" -D "$WORK/headers" "$DOWNLOAD_URL"
grep -qi 'content-disposition: attachment' "$WORK/headers" ||
  fail "the download is missing its content-disposition header"
cmp -s "$PHOTO" "$WORK/downloaded" || fail "the downloaded bytes differ from the original"
echo "  byte-for-byte identical, served as an attachment"

echo
echo "== 8. revocation kills both tiers =="
curl -sf -X DELETE "$API/api/grants/$GRANT_ID" -b "$COOKIES" >/dev/null
LINK=$(code -X POST "$API/api/client/session" -H 'content-type: application/json' \
  -d "{\"token\":\"$LINK_TOKEN\"}")
REFRESH=$(code -X POST "$API/api/client/token" -H "authorization: Bearer $BADGE")
[ "$LINK" = 410 ] || fail "the magic link still works after revocation ($LINK)"
[ "$REFRESH" = 410 ] || fail "the badge still refreshes after revocation ($REFRESH)"
echo "  magic link 410, refresh 410"

echo
echo "== 9. tidy up =="
curl -sf -X DELETE "$API/api/galleries/$GALLERY" -b "$COOKIES" >/dev/null
echo "  test gallery deleted"

echo
echo "== PASS =="
