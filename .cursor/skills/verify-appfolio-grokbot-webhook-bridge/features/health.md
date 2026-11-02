# Health

Health tells an operator the bridge process is answering.

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

- `200` means `loadConfig` succeeded. The body file is exactly `{"ok":true}`.
- `500` means webhook config failed. The body is `{"ok":false,"reason":"<token>"}`. The token is `config_missing_webhook_url`, `config_missing_bearer_token`, `config_invalid_url`, or `config_misconfigured`. It is not the error message, the webhook URL, or the bearer token.
- An unsigned POST is still the check that the webhook route reached signature rejection.
- An unset `POSTHOG_PROJECT_KEY` does not fail this route.
- Do not accept a body that only contains `ok` inside a larger document. The success file must be exactly `{"ok":true}`.
