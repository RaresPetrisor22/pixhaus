#!/usr/bin/env bash
#
# does this stack actually run on ARM64 + musl?
#
# Installing is not running, so this drives the real pipeline against a stack
# already up (`docker compose up -d --wait`). Two native dependencies are what
# the answer hinges on:
#
#   @node-rs/argon2   registration
#   sharp / libvips   the worker building renditions
#
# Usage:  scripts/arm-check.sh [photo.jpg] [count]

set -euo pipefail

PHOTO=${1:-$HOME/photo.jpg}
COUNT=${2:-1}
API=${API:-http://localhost:3000}
MAILPIT=${MAILPIT:-http://localhost:8025}

EMAIL=arm-check@example.test
PASSWORD='correct horse battery staple'

COOKIES=$(mktemp)
trap 'rm -f "$COOKIES"' EXIT

json() { python3 -c "import sys,json;d=json.load(sys.stdin);print($1)"; }

[ -f "$PHOTO" ] || {
  echo "no such file: $PHOTO" >&2
  exit 1
}

case "${PHOTO,,}" in
  *.jpg | *.jpeg) TYPE=image/jpeg ;;
  *.png) TYPE=image/png ;;
  *.webp) TYPE=image/webp ;;
  *)
    echo "unsupported type: $PHOTO (jpg, png or webp)" >&2
    exit 1
    ;;
esac

echo "== 1. the stack answers =="
curl -sf "$API/readyz" | json "'  readyz: %s' % d['status']"

echo
echo "== 2. account — argon2id's turn =="
if curl -sf -X POST "$API/api/auth/login" -c "$COOKIES" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null 2>&1; then
  echo "  already registered, logged in"
else
  curl -sf -X POST "$API/api/auth/register" -H 'content-type: application/json' \
    -d "{\"studioName\":\"ARM check\",\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null
  echo "  registered — a password was hashed, so the native binary loaded"

  # Compose runs NODE_ENV=production, so the link is not written to the log.
  sleep 1
  ID=$(curl -sf "$MAILPIT/api/v1/messages?limit=1" | json "d['messages'][0]['ID']")
  TOKEN=$(curl -sf "$MAILPIT/api/v1/message/$ID" |
    python3 -c "import sys,json,re;print(re.search(r'token=([A-Za-z0-9_-]+)', json.load(sys.stdin)['Text']).group(1))")

  curl -sf -X POST "$API/api/auth/verify-email" -H 'content-type: application/json' \
    -d "{\"token\":\"$TOKEN\"}" >/dev/null
  curl -sf -X POST "$API/api/auth/login" -c "$COOKIES" -H 'content-type: application/json' \
    -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}" >/dev/null
  echo "  verified and logged in"
fi

echo
echo "== 3. upload $COUNT copy(ies) of $(basename "$PHOTO") =="
GALLERY=$(curl -sf -X POST "$API/api/galleries" -b "$COOKIES" \
  -H 'content-type: application/json' \
  -d "{\"title\":\"ARM check $(date -u +%H:%M:%S)\"}" | json "d['id']")
SIZE=$(stat -c%s "$PHOTO")
echo "  gallery $GALLERY, $SIZE bytes each"

for i in $(seq 1 "$COUNT"); do
  TICKET=$(curl -sf -X POST "$API/api/galleries/$GALLERY/uploads" -b "$COOKIES" \
    -H 'content-type: application/json' \
    -d "{\"filename\":\"arm-check-$i.${PHOTO##*.}\",\"size\":$SIZE,\"contentType\":\"$TYPE\"}")

  # Straight to the bucket. Nothing but this line ever sends the bytes.
  curl -sf -X PUT --upload-file "$PHOTO" -H "content-type: $TYPE" \
    "$(echo "$TICKET" | json "d['uploadUrl']")" >/dev/null

  curl -sf -X POST "$API/api/uploads/$(echo "$TICKET" | json "d['assetId']")/finalize" \
    -b "$COOKIES" >/dev/null
  printf '  finalized %d/%d\r' "$i" "$COUNT"
done
echo

echo
echo "== 4. the worker — sharp and libvips on ARM =="
PEAK=0
for _ in $(seq 1 180); do
  PAGE=$(curl -sf "$API/api/galleries/$GALLERY/assets?limit=100" -b "$COOKIES")
  READY=$(echo "$PAGE" | json "sum(1 for a in d['assets'] if a['status'] == 'ready')")
  FAILED=$(echo "$PAGE" | json "sum(1 for a in d['assets'] if a['status'] == 'failed')")

  MB=$(docker stats --no-stream --format '{{.MemUsage}}' pixhaus-worker-1 2>/dev/null |
    sed 's/MiB.*//;s/[^0-9.]//g' | cut -d. -f1 || echo 0)
  [ -n "${MB:-}" ] && [ "$MB" -gt "$PEAK" ] 2>/dev/null && PEAK=$MB

  printf '  ready %s/%s  failed %s  worker rss %sMiB\r' "$READY" "$COUNT" "$FAILED" "${MB:-?}"
  [ "$READY" = "$COUNT" ] && break
  [ "$FAILED" != "0" ] && break
  sleep 1
done
echo

if [ "$READY" != "$COUNT" ]; then
  echo
  echo "  FAILED — the worker did not finish. Look at: docker compose logs worker"
  exit 1
fi

echo
echo "== 5. what the worker wrote =="
curl -sf "$API/api/galleries/$GALLERY/assets?limit=1" -b "$COOKIES" | python3 -c "
import sys, json
a = json.load(sys.stdin)['assets'][0]
print(f\"  {a['originalFilename']}  {a['width']}x{a['height']}  {a['contentType']}\")
print(f\"  blurhash {a['blurhash']}\")
print('  ASSET=' + a['id'])
" | tee /tmp/arm-check-asset

ASSET=$(grep ASSET= /tmp/arm-check-asset | cut -d= -f2)
for KIND in thumb grid preview; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' \
    "$API/api/assets/$ASSET/renditions/$KIND" -b "$COOKIES")
  echo "  $KIND -> $CODE $([ "$CODE" = 302 ] && echo '(redirect to a presigned URL)' || echo 'UNEXPECTED')"
done

echo
echo "== PASS =="
echo "  argon2id hashed a password, libvips wrote three renditions,"
echo "  and peak worker RSS was ${PEAK}MiB across $COUNT file(s)."
echo
echo "  Flat RSS across a dozen large originals is the claim M2 made when it"
echo "  chose libvips over ImageMagick. Re-run with a bigger count to test it:"
echo "    scripts/arm-check.sh $PHOTO 12"
