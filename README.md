# appfolio-grokbot-webhook-bridge

Thin HTTPS verify-and-forward for AppFolio webhooks → Grok Bot.

AppFolio signs with detached JWS (`X-JWS-Signature`, PS256). Grok Bot expects `Authorization: Bearer crsr_…`. This service verifies AppFolio, then forwards the **raw** JSON body to the Bot webhook URL.

Deploy target: Vercel (CI deploys on merge to `main`). Custom domain required so AppFolio’s company-owned-domain rule is satisfied.

## Routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/api/health` | Liveness → `200 { ok: true }` |
| `POST` | `/api/webhooks/appfolio` | Verify AppFolio JWS, forward raw body to Grok Bot |

## Environment (Vercel only — never commit secrets)

| Variable | Required | Description |
|----------|----------|-------------|
| `GROK_BOT_WEBHOOK_URL` | yes | Full URL of the Grok Bot inbound webhook |
| `GROK_BOT_BEARER_TOKEN` | yes | Bearer token (`crsr_…`) |
| `APPFOLIO_JWKS_URL` | no | Override JWKS URL (default `https://api.appfolio.com/.well-known/jwks.json`) |

Copy `.env.example` for local `vercel dev`.

## Raw body on Vercel (important)

AppFolio’s detached JWS is over the **exact request bytes**. Parsing JSON and re-stringifying changes whitespace/key order and breaks verification (and would corrupt the forward).

The webhook route disables Vercel’s default body parser:

```ts
export const config = { api: { bodyParser: false } };
```

It then buffers the Node request stream into a `Uint8Array` used for both `compactVerify` and the upstream `fetch` body. Do not call `JSON.parse` / `JSON.stringify` on the payload before verify or forward.

## Auth flow

1. Read `X-JWS-Signature` (detached compact JWS: `header..signature`).
2. Base64url-encode raw body as the JWS payload segment; reconstruct compact JWS; verify with PS256 against AppFolio JWKS ([reference](https://github.com/appfolio/stack-webhook-jws-examples)).
3. On success, `POST` the same raw bytes to `GROK_BOT_WEBHOOK_URL` with `Authorization: Bearer …`.
4. Status mapping: verify fail → `401`; upstream 2xx → `200`; upstream error → `502`.

No `event_id` store in v1 — idempotency is the Bot / downstream.

## Local development

```bash
npm install
npm run typecheck
npm test
npx vercel dev   # after setting env (vercel env pull or .env)
```

## Design

See [DESIGN.md](./DESIGN.md) (locked).
