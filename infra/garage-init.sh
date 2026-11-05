#!/bin/sh
# One-time (idempotent) setup of the local Garage node: layout, access key and bucket.
# Runs in its own alpine container sharing the garage container's network namespace,
# since the garage image itself is a bare static binary with no shell/curl.
set -eu

apk add --no-cache curl jq >/dev/null

ADMIN_URL="http://127.0.0.1:3903/v1"
AUTH="Authorization: Bearer ${GARAGE_ADMIN_TOKEN}"

echo "garage-init: waiting for admin API..."
for i in $(seq 1 30); do
  if curl -fs -H "$AUTH" "$ADMIN_URL/status" >/tmp/status.json 2>/dev/null; then
    break
  fi
  sleep 1
done
curl -fs -H "$AUTH" "$ADMIN_URL/status" >/tmp/status.json
curl -fs -H "$AUTH" "$ADMIN_URL/layout" >/tmp/layout.json

NODE_ID=$(jq -r '.node' /tmp/status.json)
CURRENT_VERSION=$(jq -r '.version' /tmp/layout.json)
HAS_ROLE=$(jq --arg id "$NODE_ID" '.roles | map(select(.id == $id)) | length' /tmp/layout.json)

if [ "$HAS_ROLE" = "0" ]; then
  echo "garage-init: assigning layout to node $NODE_ID"
  curl -fs -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d "[{\"id\":\"$NODE_ID\",\"zone\":\"dc1\",\"capacity\":1000000000,\"tags\":[]}]" \
    "$ADMIN_URL/layout" >/dev/null

  NEW_VERSION=$((CURRENT_VERSION + 1))
  curl -fs -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"version\":$NEW_VERSION}" \
    "$ADMIN_URL/layout/apply" >/dev/null
  echo "garage-init: layout applied (version $NEW_VERSION)"
else
  echo "garage-init: layout already assigned, skipping"
fi

echo "garage-init: ensuring access key $GARAGE_KEY_NAME exists"
if ! curl -fs -H "$AUTH" "$ADMIN_URL/key?id=$GARAGE_ACCESS_KEY_ID" >/dev/null 2>&1; then
  curl -fs -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"name\":\"$GARAGE_KEY_NAME\",\"accessKeyId\":\"$GARAGE_ACCESS_KEY_ID\",\"secretAccessKey\":\"$GARAGE_SECRET_ACCESS_KEY\"}" \
    "$ADMIN_URL/key/import" >/dev/null
  echo "garage-init: imported key $GARAGE_ACCESS_KEY_ID"
else
  echo "garage-init: key already exists, skipping import"
fi

echo "garage-init: ensuring bucket $GARAGE_BUCKET exists"
if ! curl -fs -H "$AUTH" "$ADMIN_URL/bucket?globalAlias=$GARAGE_BUCKET" >/tmp/bucket.json 2>&1; then
  curl -fs -X POST -H "$AUTH" -H "Content-Type: application/json" \
    -d "{\"globalAlias\":\"$GARAGE_BUCKET\"}" \
    "$ADMIN_URL/bucket" >/tmp/bucket.json
  echo "garage-init: created bucket $GARAGE_BUCKET"
else
  echo "garage-init: bucket already exists, skipping create"
fi
BUCKET_ID=$(jq -r '.id' /tmp/bucket.json)

echo "garage-init: granting key access to bucket"
curl -fs -X POST -H "$AUTH" -H "Content-Type: application/json" \
  -d "{\"bucketId\":\"$BUCKET_ID\",\"accessKeyId\":\"$GARAGE_ACCESS_KEY_ID\",\"permissions\":{\"read\":true,\"write\":true,\"owner\":true}}" \
  "$ADMIN_URL/bucket/allow" >/dev/null

echo "garage-init: done"
