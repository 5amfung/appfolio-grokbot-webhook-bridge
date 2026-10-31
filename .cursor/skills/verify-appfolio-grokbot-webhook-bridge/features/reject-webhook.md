# Reject a webhook

A caller who posts to the webhook route without a valid detached signature is rejected, and nothing is forwarded.

## Sub-features

- `reject-missing` rejects a POST with no `X-JWS-Signature`.
- `reject-malformed` rejects a signature value that is not detached JWS (`header..signature`).
- `reject-tamper` rejects a signature when the sent bytes differ from the signed bytes.

## How to get to it (user POV)

- `POST /api/webhooks/appfolio` with no `X-JWS-Signature`.
- `POST /api/webhooks/appfolio` with `X-JWS-Signature: not-a-detached-jws`.
- `POST /api/webhooks/appfolio` with a signature over a different body than the one sent.

## Driving it with the HTTP harness

Preconditions:

- Doctor printed `ok` for `$RUN_DIR`.
- `BASE_URL` is the bridge launch printed.
- `$RUN_DIR/upstream-status` is `204`.

- **Missing signature.** Run `mkdir -p "$EVIDENCE_DIR/reject-webhook"` and `BEFORE=$(wc -l < "$RUN_DIR/upstream-captures.jsonl" | tr -d ' ')` and `curl -sS -D "$EVIDENCE_DIR/reject-webhook/missing.headers" -o "$EVIDENCE_DIR/reject-webhook/missing.body" -X POST "$BASE_URL/api/webhooks/appfolio" -H 'content-type: application/json' --data-binary '{}'`. Then run `node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/prove-webhook.mjs --run-dir "$RUN_DIR" --response-body "$EVIDENCE_DIR/reject-webhook/missing.body" --response-headers "$EVIDENCE_DIR/reject-webhook/missing.headers" --captures-before "$BEFORE" --expect-status 401 --expect-body '{"error":"missing X-JWS-Signature header"}' --expect-forward false --out "$EVIDENCE_DIR/reject-webhook/missing.proof.json"`. Status `401`, that error body, and the capture count is unchanged.
- **Malformed signature.** Run `BEFORE=$(wc -l < "$RUN_DIR/upstream-captures.jsonl" | tr -d ' ')` and `curl -sS -D "$EVIDENCE_DIR/reject-webhook/malformed.headers" -o "$EVIDENCE_DIR/reject-webhook/malformed.body" -X POST "$BASE_URL/api/webhooks/appfolio" -H 'content-type: application/json' -H 'X-JWS-Signature: not-a-detached-jws' --data-binary '{}'`. Then run `node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/prove-webhook.mjs --run-dir "$RUN_DIR" --response-body "$EVIDENCE_DIR/reject-webhook/malformed.body" --response-headers "$EVIDENCE_DIR/reject-webhook/malformed.headers" --captures-before "$BEFORE" --expect-status 401 --expect-body '{"error":"invalid detached JWS format"}' --expect-forward false --out "$EVIDENCE_DIR/reject-webhook/malformed.proof.json"`. Status `401`, that error body, and the capture count is unchanged.
- **Tampered body.** Run `printf '%s' '{"event_id":"reject-tamper"}' > "$EVIDENCE_DIR/reject-webhook/original.body"` and `printf '%s' '{"event_id":"reject-tamper"} ' > "$EVIDENCE_DIR/reject-webhook/tampered.body"` and `SIG=$(node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/sign-detached.mjs --private-jwk "$RUN_DIR/private.jwk" --body-file "$EVIDENCE_DIR/reject-webhook/original.body")` and `BEFORE=$(wc -l < "$RUN_DIR/upstream-captures.jsonl" | tr -d ' ')` and `curl -sS -D "$EVIDENCE_DIR/reject-webhook/tamper.headers" -o "$EVIDENCE_DIR/reject-webhook/tamper.body" -X POST "$BASE_URL/api/webhooks/appfolio" -H 'content-type: application/json' -H "X-JWS-Signature: $SIG" --data-binary @"$EVIDENCE_DIR/reject-webhook/tampered.body"`. Then run `node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/prove-webhook.mjs --run-dir "$RUN_DIR" --response-body "$EVIDENCE_DIR/reject-webhook/tamper.body" --response-headers "$EVIDENCE_DIR/reject-webhook/tamper.headers" --captures-before "$BEFORE" --expect-status 401 --expect-forward false --out "$EVIDENCE_DIR/reject-webhook/tamper.proof.json"`. Status `401`, a non-empty `error` string, and the capture count is unchanged.

## Gotchas

- Sign `original.body` and send `tampered.body`. Sending the signed file accepts the request.
- Take `BEFORE` immediately before each POST. A shared count from an earlier request hides a forward.
- The tamper error text comes from signature verification and is not a fixed sentence. Require `401`, a non-empty `error`, and no new capture.
- An empty `X-JWS-Signature` is the missing-header rejection, not the malformed-format rejection.
