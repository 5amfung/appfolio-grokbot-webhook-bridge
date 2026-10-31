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

- `200` on this route does not mean webhook config loaded. Doctor's unsigned POST is what checks that.
- Do not accept a body that only contains `ok` inside a larger document. The file must be exactly `{"ok":true}`.
