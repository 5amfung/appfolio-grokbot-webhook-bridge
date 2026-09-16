# Design (locked)

## Data shape

Outbound AppFolio event (wire JSON, single-event form):

- client_id: string
- event_id: string
- topic: string
- resource_id: string
- event_timestamp: string (ISO)
- message_sent_at: string (ISO)
- event_type: string
- database_id?: string

Handler outcome (discriminated):

- { kind: "unauthorized"; reason: string }
- { kind: "forwarded"; upstreamStatus: number }
- { kind: "upstream_failure"; error: string }

Config (from env, parsed once at cold start):

- grokBotWebhookUrl: URL
- grokBotBearerToken: string (crsr_…)
- appfolioJwksUrl: URL (default https://api.appfolio.com/.well-known/jwks.json)

## Modules

1. `src/verify-appfolio-jws.ts` — pure. Inputs: rawBody: Uint8Array, signatureHeader: string, jwks. Verify detached JWS PS256 against AppFolio JWKS. No HTTP framework imports.
2. `src/forward-to-grok-bot.ts` — pure-ish. POST body + Bearer. Returns status.
3. `api/webhooks/appfolio.ts` (or App Router equivalent) — boundary. Read raw body. Call verify. On fail 401. On pass forward. Map to 200 / 502.
4. `api/health.ts` — GET 200 ok.

## Constraints

- Raw body required for verify. Do not JSON.parse then re-stringify before verify or forward.
- No event_id store in v1. Idempotency is the Bot / downstream.
- No secrets in repo. Vercel env only.
- Tests: verify unit tests with fixtures; route integration with mocked upstream.

## Commit story (one PR)

1. Scaffold: package.json, tsconfig, vercel, health route, README polish, CI note.
2. Verify module + unit tests.
3. Forward + webhook route + integration tests.
