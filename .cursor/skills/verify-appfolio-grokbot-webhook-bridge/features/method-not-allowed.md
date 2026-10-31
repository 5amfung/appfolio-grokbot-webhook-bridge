# Method not allowed

The webhook route accepts POST only. Other methods are rejected before any signature check or forward.

## Sub-features

- `webhook-get` rejects `GET /api/webhooks/appfolio`.
- `webhook-put` rejects `PUT /api/webhooks/appfolio`.

## How to get to it (user POV)

- `GET /api/webhooks/appfolio`
- `PUT /api/webhooks/appfolio`

## Driving it with the HTTP harness

Preconditions:

- Doctor printed `ok` for `$RUN_DIR`.
- `BASE_URL` is the bridge launch printed.

- **GET.** Run `mkdir -p "$EVIDENCE_DIR/method-not-allowed"` and `BEFORE=$(wc -l < "$RUN_DIR/upstream-captures.jsonl" | tr -d ' ')` and `curl -sS -D "$EVIDENCE_DIR/method-not-allowed/get.headers" -o "$EVIDENCE_DIR/method-not-allowed/get.body" "$BASE_URL/api/webhooks/appfolio"`. Then run `node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/prove-webhook.mjs --run-dir "$RUN_DIR" --response-body "$EVIDENCE_DIR/method-not-allowed/get.body" --response-headers "$EVIDENCE_DIR/method-not-allowed/get.headers" --captures-before "$BEFORE" --expect-status 405 --expect-body '{"error":"method not allowed"}' --expect-header 'Allow: POST' --expect-forward false --out "$EVIDENCE_DIR/method-not-allowed/get.proof.json"`. Status `405`, that body, header `Allow: POST`, capture count unchanged.
- **PUT.** Run `BEFORE=$(wc -l < "$RUN_DIR/upstream-captures.jsonl" | tr -d ' ')` and `curl -sS -D "$EVIDENCE_DIR/method-not-allowed/put.headers" -o "$EVIDENCE_DIR/method-not-allowed/put.body" -X PUT "$BASE_URL/api/webhooks/appfolio" --data-binary '{}'`. Then run `node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/prove-webhook.mjs --run-dir "$RUN_DIR" --response-body "$EVIDENCE_DIR/method-not-allowed/put.body" --response-headers "$EVIDENCE_DIR/method-not-allowed/put.headers" --captures-before "$BEFORE" --expect-status 405 --expect-body '{"error":"method not allowed"}' --expect-header 'Allow: POST' --expect-forward false --out "$EVIDENCE_DIR/method-not-allowed/put.proof.json"`. Same `405` result and no new capture.

## Gotchas

- `Allow` may be lowercase on the wire. The proof check is case-insensitive on the name and exact on `POST`.
- These responses do not require a signature. Adding one does not change the route's answer, and it is not a substitute for the reject-webhook recipes.
