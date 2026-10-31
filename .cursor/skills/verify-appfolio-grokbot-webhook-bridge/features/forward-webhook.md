# Forward a signed webhook

A caller with a valid detached signature has the same raw bytes delivered to the bot, and the bridge reports the bot's success status.

## Sub-features

- `forward-raw` accepts a PS256 detached signature and forwards the posted bytes unchanged.

## How to get to it (user POV)

- `POST /api/webhooks/appfolio` with `content-type: application/json`, a body, and `X-JWS-Signature` set to the detached signature of those exact bytes.

## Driving it with the HTTP harness

Preconditions:

- Doctor printed `ok` for `$RUN_DIR`.
- `BASE_URL` is the bridge launch printed.
- `$RUN_DIR/upstream-status` is `204`.
- No earlier drive left `$RUN_DIR/upstream-status` at another code.

- **Write the body.** Keep the space after `"verify-client",`. Run `mkdir -p "$EVIDENCE_DIR/forward-signed"` and `printf '%s' '{"client_id":"verify-client", "event_id":"verify-evt-1","topic":"work_orders","resource_id":"res-verify","event_timestamp":"2026-10-30T12:00:00Z","message_sent_at":"2026-10-30T12:00:01Z","event_type":"create","database_id":"db-verify"}' > "$EVIDENCE_DIR/forward-signed/request.body"`.
- **Sign and send.** Run `BEFORE=$(wc -l < "$RUN_DIR/upstream-captures.jsonl" | tr -d ' ')` and `SIG=$(node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/sign-detached.mjs --private-jwk "$RUN_DIR/private.jwk" --body-file "$EVIDENCE_DIR/forward-signed/request.body")` and `curl -sS -D "$EVIDENCE_DIR/forward-signed/response.headers" -o "$EVIDENCE_DIR/forward-signed/response.body" -X POST "$BASE_URL/api/webhooks/appfolio" -H 'content-type: application/json' -H "X-JWS-Signature: $SIG" --data-binary @"$EVIDENCE_DIR/forward-signed/request.body"`.
- **Prove the side effect.** Run `node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/prove-webhook.mjs --run-dir "$RUN_DIR" --body-file "$EVIDENCE_DIR/forward-signed/request.body" --response-body "$EVIDENCE_DIR/forward-signed/response.body" --response-headers "$EVIDENCE_DIR/forward-signed/response.headers" --captures-before "$BEFORE" --expect-status 200 --expect-body '{"ok":true,"upstreamStatus":204}' --expect-forward true --expect-upstream-status 204 --out "$EVIDENCE_DIR/forward-signed/proof.json"`. The bridge body is `{"ok":true,"upstreamStatus":204}`. `proof.json` has `bodiesMatch`, `authorizationMatch`, `contentTypeMatch`, and `upstreamStatusMatch` all true. The capture count grew by one.

## Gotchas

- The space after `"verify-client",` must survive the round trip. Reformatting the JSON makes the signature check fail or the byte compare fail.
- Use `--data-binary`. `--data` is the wrong curl mode for a file whose bytes must stay exact.
- `{"ok":true,"upstreamStatus":204}` without `bodiesMatch: true` is not a forward proof.
- `$()` strips the trailing newline from the signer. That newline is not part of the header value.
- Leave `upstream-status` at `204`. This recipe does not change it.
