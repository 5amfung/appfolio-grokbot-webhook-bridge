# Health

Health tells an operator the bridge process and its configured dependency URLs are reachable.

## Sub-features

- `health-get` returns `200` and `{"ok":true}`.

## How to get to it (user POV)

- `GET /api/health`

## Driving it with the HTTP harness

Preconditions:

- Doctor printed `ok` for `$RUN_DIR`.
- `BASE_URL` is the bridge launch printed.

- **GET health.** Request the health route. Run `mkdir -p "$EVIDENCE_DIR/health"` and `curl -sS -D "$EVIDENCE_DIR/health/response.headers" -o "$EVIDENCE_DIR/health/response.body" "$BASE_URL/api/health"`. The headers status line is `200` and the body file is exactly `{"ok":true}`.

## Gotchas

- `200` means `loadConfig` succeeded and both dependency probes passed. The body file is exactly `{"ok":true}`.
- Probes run concurrently with a five-second deadline per URL. JWKS uses `GET` and requires `200`. Grok Bot uses authenticated `HEAD` and accepts `2xx` or `405` for a POST-only webhook. Health never sends a webhook payload or follows a redirect.
- `503` means a dependency probe failed. The body contains `{"ok":false,"reason":"dependency_unavailable","checks":{...}}`. Each `appfolio_jwks` and `grok_bot` check contains `ok`, an HTTP `status` when available, and a failure `reason` of `http_error`, `timeout`, or `network_error`. URLs, credentials, response bodies, and error text are excluded.
- All health responses set `Cache-Control: no-store`.
- Reachability does not verify Grok Bot POST acceptance or bot processing. A `405` does not verify its bearer token. JWKS availability does not validate the key set.
- `500` means webhook config failed. The body is `{"ok":false,"reason":"<token>"}`. The token is `config_missing_webhook_url`, `config_missing_bearer_token`, `config_invalid_url`, or `config_misconfigured`. It is not the error message, the webhook URL, or the bearer token.
- Both dependency URLs require HTTPS. HTTP URLs, including loopback addresses, fail with `config_invalid_url` before either probe starts.
- An unsigned POST is still the check that the webhook route reached signature rejection.
- An unset `POSTHOG_PROJECT_KEY` does not fail this route.
- Do not accept a body that only contains `ok` inside a larger document. The success file must be exactly `{"ok":true}`.
