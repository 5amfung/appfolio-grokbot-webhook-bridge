# Upstream failure

A valid signed event is still forwarded when the bot returns an error, and the bridge reports that failure to the caller.

## Sub-features

- `upstream-500` maps a bot HTTP 500 to bridge `502` and still records the raw body.

## How to get to it (user POV)

- `POST /api/webhooks/appfolio` with a valid detached signature while the bot responds `500`.

## Driving it with the HTTP harness

Preconditions:

- Doctor printed `ok` for `$RUN_DIR`.
- `BASE_URL` is the bridge launch printed.
- `$RUN_DIR/upstream-status` starts at `204`.

- **Fail the bot.** Run `printf '500\n' > "$RUN_DIR/upstream-status"`.
- **Sign and send.** Run `mkdir -p "$EVIDENCE_DIR/upstream-failure"` and `printf '%s' '{"client_id":"verify-client", "event_id":"verify-upstream-500","topic":"work_orders","resource_id":"res-verify","event_timestamp":"2026-10-30T12:00:00Z","message_sent_at":"2026-10-30T12:00:01Z","event_type":"create"}' > "$EVIDENCE_DIR/upstream-failure/request.body"` and `BEFORE=$(wc -l < "$RUN_DIR/upstream-captures.jsonl" | tr -d ' ')` and `SIG=$(node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/sign-detached.mjs --private-jwk "$RUN_DIR/private.jwk" --body-file "$EVIDENCE_DIR/upstream-failure/request.body")` and `curl -sS -D "$EVIDENCE_DIR/upstream-failure/response.headers" -o "$EVIDENCE_DIR/upstream-failure/response.body" -X POST "$BASE_URL/api/webhooks/appfolio" -H 'content-type: application/json' -H "X-JWS-Signature: $SIG" --data-binary @"$EVIDENCE_DIR/upstream-failure/request.body"`.
- **Prove the failure was a real forward.** Run `node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/prove-webhook.mjs --run-dir "$RUN_DIR" --body-file "$EVIDENCE_DIR/upstream-failure/request.body" --response-body "$EVIDENCE_DIR/upstream-failure/response.body" --response-headers "$EVIDENCE_DIR/upstream-failure/response.headers" --captures-before "$BEFORE" --expect-status 502 --expect-body '{"error":"upstream returned 500"}' --expect-forward true --expect-upstream-status 500 --out "$EVIDENCE_DIR/upstream-failure/proof.json"`. Bridge status `502`, that error body, one new capture, and `bodiesMatch` true.
- **Restore the baseline.** Run `printf '204\n' > "$RUN_DIR/upstream-status"` and doctor again. Doctor must print `ok` before another feature.

## Gotchas

- Restore `204` even when the proof fails. A later signed POST will keep returning `502` until the file is restored.
- Doctor does not rewrite `upstream-status`. It only reports it.
- `502` with `bodiesMatch: false` means the bridge failed without delivering the caller's bytes. That is not this feature.
