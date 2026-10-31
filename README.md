# appfolio-grokbot-webhook-bridge

Thin HTTPS verify-and-forward for AppFolio webhooks → Grok Bot.

AppFolio signs with detached JWS (`X-JWS-Signature`, PS256). Grok Bot expects `Authorization: Bearer crsr_…`. This service verifies AppFolio, then forwards the **raw** JSON body to the Bot webhook URL.

Deploy target: Vercel. Production updates only when a release merges. See [Releases and deployment](#releases-and-deployment). Custom domain required so AppFolio’s company-owned-domain rule is satisfied.

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
| `POSTHOG_PROJECT_KEY` | no | PostHog project token (`phc_…`). Unset → telemetry is a no-op (no network). Not a personal API key (`phx_…`). |
| `POSTHOG_HOST` | no | PostHog ingest host (default `https://us.i.posthog.com`; EU Cloud is `https://eu.i.posthog.com`) |

Set `POSTHOG_PROJECT_KEY` (and `POSTHOG_HOST` only if the project is not on US Cloud) in the Vercel project for the environments you want to observe. This repo does not set those variables.

Copy `.env.example` for local `vercel dev`.

## Telemetry (PostHog)

Server-side only (`posthog-node` plus the [Node.js logs](https://posthog.com/docs/logs/installation/nodejs) OpenTelemetry pipeline). There is no browser SDK.

When `POSTHOG_PROJECT_KEY` is unset, `createBridgeTelemetry()` does not construct a client or start OpenTelemetry, so local dev, tests, and CI make no telemetry calls.

Logs are OTLP records sent to `{POSTHOG_HOST}/i/v1/logs` with this service identity:

| Resource attribute | Value |
|--------------------|--------|
| `service.name` | `appfolio-grokbot-webhook-bridge` |
| `deployment.environment` | `VERCEL_ENV`, or `development` when unset |
| `service.version` | `VERCEL_GIT_COMMIT_SHA`, or this package's `version` |

Console log autocapture is off. Do not send request bodies, headers, signatures, bearer tokens, upstream URLs, or AppFolio payload fields. Later captures use the fixed distinct id `appfolio-grokbot-webhook-bridge` and disable person profiles.

Uncaught exceptions and unhandled rejections are autocaptured. The webhook route also records handled failures with `captureException` and a `source` of `config`, `webhook`, or `upstream`. Rejected signatures stay a 401 and are not exception events. Webhook outcome events and metric calls are not recorded yet. Create the client once per isolate, `await telemetry.flush()` before the function returns, and `await telemetry.shutdown()` on process exit. `captureException` never throws. Flush and shutdown swallow failures and give up after one second, so a PostHog outage cannot change the HTTP status or hang AppFolio.

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

Requires Node 24 (`package.json` `engines` is `24.x`. CI runs Node 24).

```bash
pnpm install
pnpm run typecheck
pnpm test
pnpm dlx vercel dev   # after setting env (vercel env pull or .env)
```

`package.json` has no `dev` script. `vercel dev` runs `scripts.dev` when one is set, and a `dev` script of `vercel dev` aborts as a recursive invocation.

## Releases and deployment

Use a [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) title on each pull request. Squash-merge it so that the title is the commit subject on `main`.

Release Please runs on every push to `main`. It keeps one release pull request open. That pull request bumps the version in `package.json` and writes `CHANGELOG.md`. Do not edit the changelog by hand. Merge the release pull request to create the git tag and the GitHub Release.

The release commit subject is `chore(main): release X.Y.Z`. GitHub appends ` (#N)` on a squash merge. `include-component-in-tag` is false, so the subject has no package name and the tag is `vX.Y.Z`.

Vercel keeps its Git integration. `vercel.json` points `ignoreCommand` at `scripts/vercel-ignore-build.sh`.

- A preview deployment always builds.
- A production deployment builds only when a line of the commit message is that release subject.
- Any other merge to `main` is skipped. Vercel shows that deployment as canceled.

The Ignored Build Step leaves the Vercel Git integration in place. A Vercel CLI production deploy needs a Vercel token in Actions secrets. A Deploy Hook needs the hook URL as a secret. This repo stores neither secret, and the Git integration still deploys the release commit.

Release Please uses the default `GITHUB_TOKEN`. GitHub does not start workflows for a pull request that token opens, so the release pull request does not run CI. CI runs when the release pull request merges to `main`.

## Design

See [DESIGN.md](./DESIGN.md) (locked).
