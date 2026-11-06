# appfolio-grokbot-webhook-bridge

Thin HTTPS verify-and-forward for AppFolio webhooks → Grok Bot.

AppFolio signs with detached JWS (`X-JWS-Signature`, PS256). Grok Bot expects `Authorization: Bearer crsr_…`. This service verifies AppFolio, then forwards the **raw** JSON body to the Bot webhook URL.

Deploy target: Vercel. Production updates only when a release merges. See [Releases and deployment](#releases-and-deployment). Custom domain required so AppFolio’s company-owned-domain rule is satisfied.

## Routes

| Method | Path                     | Purpose                                                                                     |
| ------ | ------------------------ | ------------------------------------------------------------------------------------------- |
| `GET`  | `/api/health`            | `200 { ok: true }` when webhook config loads. `500 { ok: false, reason }` when it does not. |
| `POST` | `/api/webhooks/appfolio` | Verify AppFolio JWS, forward raw body to Grok Bot                                           |

## Environment (Vercel only — never commit secrets)

| Variable                | Required | Description                                                                                                   |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `GROK_BOT_WEBHOOK_URL`  | yes      | Full URL of the Grok Bot inbound webhook                                                                      |
| `GROK_BOT_BEARER_TOKEN` | yes      | Bearer token (`crsr_…`)                                                                                       |
| `APPFOLIO_JWKS_URL`     | no       | Override JWKS URL (default `https://api.appfolio.com/.well-known/jwks.json`)                                  |
| `POSTHOG_PROJECT_KEY`   | no       | PostHog project token (`phc_…`). Unset → telemetry is a no-op (no network). Not a personal API key (`phx_…`). |
| `POSTHOG_HOST`          | no       | PostHog ingest host (default `https://us.i.posthog.com`; EU Cloud is `https://eu.i.posthog.com`)              |

Set `POSTHOG_PROJECT_KEY` (and `POSTHOG_HOST` only if the project is not on US Cloud) in the Vercel project for the environments you want to observe. This repo does not set those variables.

Copy `.env.example` for local `vercel dev`.

## Telemetry (PostHog)

Server-side only (`posthog-node` plus the [Node.js logs](https://posthog.com/docs/logs/installation/nodejs) OpenTelemetry pipeline). There is no browser SDK.

When `POSTHOG_PROJECT_KEY` is unset, `createBridgeTelemetry()` does not construct a client or start OpenTelemetry, so local dev, tests, and CI make no telemetry calls.

Logs are OTLP records sent to `{POSTHOG_HOST}/i/v1/logs` with this service identity:

| Resource attribute       | Value                                                |
| ------------------------ | ---------------------------------------------------- |
| `service.name`           | `appfolio-grokbot-webhook-bridge`                    |
| `deployment.environment` | `VERCEL_ENV`, or `development` when unset            |
| `service.version`        | `VERCEL_GIT_COMMIT_SHA`, or this package's `version` |

Console log autocapture is off. Webhook logs include JSON payload fields as individual `payload.*` properties. Analytics and exception events exclude payloads. The log retains only an allowlisted Vercel routing identifier from transport headers. Other transport headers, signatures, bearer tokens, and the configured upstream URL remain excluded. Analytics captures use the fixed distinct id `appfolio-grokbot-webhook-bridge` and disable person profiles.

Uncaught exceptions and unhandled rejections are autocaptured. The webhook route records a config failure with `captureException` and source `config`, and a body-read or unexpected throw with source `webhook`. A rejected signature and an upstream failure stay off the exception event. `webhook_handled` already names those outcomes. Each call records one `webhook_handled` event and one log on the `appfolio-grokbot-webhook-bridge` logger. Both include outcome fields, `environment` (`VERCEL_ENV`, or `development`), and `service_version` (`VERCEL_GIT_COMMIT_SHA`, or this package's version). A signing-key failure and a bad signature use different `reason` values. The 401 body is still the verify error string. Metric calls are not recorded yet.

Bridge metadata keys use snake_case in both logs and analytics: `duration_ms`, `outbound_duration_ms`, `upstream_status`, and `service_version`. Internal TypeScript fields remain camelCase. Payload properties preserve AppFolio's original key spelling, and OpenTelemetry resource attributes and PostHog reserved properties keep their standard names. Queries using the previous camelCase metadata keys must use the new names for records emitted after this change.

`duration_ms` retains its existing boundary: after obtaining the telemetry client through constructing the HTTP response. `outbound_duration_ms` measures the Grok Bot request separately with the monotonic `performance.now()` clock. It ends when response headers arrive or the request fails, excluding signature verification and telemetry export. Successes, HTTP failures, and network failures include this field. Requests that never attempt forwarding omit it. `upstream_status` records the Grok Bot HTTP response status when a response is received.

The outbound request has a 30-second deadline to receive response headers. After headers arrive, the bridge discards the response body with a 64 KiB read budget and a 100 ms cleanup deadline so small, complete responses can reuse their connection. Slow, oversized, or failed response bodies are aborted and canceled. Cleanup time is included in `duration_ms` and excluded from `outbound_duration_ms`. The received HTTP status still determines the outcome, so cleanup failure after an upstream 2xx does not cause a 502 or another delivery attempt. The bridge does not retry outbound requests.

Each outcome log also includes request-local diagnostics. These fields use `performance.now()` for elapsed durations and are excluded from analytics and exception events. Stages that never run are omitted, while measured zero durations and false cache flags are retained.

| Log attribute                      | Meaning                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `handler_elapsed_ms`               | Handler entry, before telemetry setup, through the outcome-log call, excluding log serialization and export.                                   |
| `telemetry_setup_duration_ms`      | Time obtaining or constructing the cached telemetry client.                                                                                    |
| `input_read_duration_ms`           | Time buffering the original request bytes, including failed reads.                                                                             |
| `verification_duration_ms`         | Complete signature verification, including signing-key lookup.                                                                                 |
| `jwks_lookup_duration_ms`          | Time awaiting the existing cached signing-key resolver, including refresh waits and failures.                                                  |
| `jwks_cache_fresh_at_lookup_start` | Whether cached keys were within their configured lifetime when lookup began.                                                                   |
| `jwks_reloading_at_lookup_start`   | Whether a signing-key fetch was already in progress when lookup began.                                                                         |
| `response_cleanup_duration_ms`     | Time after upstream headers through drain completion or cancellation request and return of control. It does not await cancellation completion. |
| `response_cleanup_outcome`         | `no_body`, `drained`, `size_limit`, `timeout`, or `read_error`. Present only when an upstream HTTP response was received.                      |
| `runtime_id`                       | UUID generated once for this loaded route module.                                                                                              |
| `runtime_request_number`           | Invocation count for that module, incremented before asynchronous work.                                                                        |
| `vercel_id`                        | Optional single `x-vercel-id` value, limited to 256 ASCII letters, digits, colons, dots, underscores, and hyphens.                             |
| `vercel_region`                    | Optional `VERCEL_REGION` execution-region value. It is not inferred from the routing identifier.                                               |

`handler_elapsed_ms` includes lazy telemetry construction that `duration_ms` excludes. Both exclude platform startup, static module imports, log serialization, and telemetry export. They measure handler work, not AppFolio receiving the response. Matching runtime IDs and increasing request numbers establish module reuse; request number one does not prove a platform cold start. Use Vercel's invocation start type to establish that.

JWKS diagnostics wrap the existing cached resolver without changing its refresh behavior or adding network requests. Concurrent lookups can share one fetch while recording separate waits. Cache freshness alone does not establish that no network request occurred. Full DNS, TCP, TLS, and upstream processing attribution is not recorded.

Only the log includes the parsed payload. The shared [AppFolio work-order webhook fixture](tests/fixtures/appfolio-work-order-webhook.json) contains `client_id`, `event_id`, `event_timestamp`, `event_type`, `message_sent_at`, `resource_id`, `topic`, and `database_id`. These appear as `payload.client_id`, `payload.event_id`, and the other corresponding `payload.*` properties. All eight values retain their string types, including `topic: work_orders` and `event_type: update`. The prefix prevents payload fields from replacing outcome fields. Parsing uses a copy for logging; verification and forwarding keep the original request bytes.

Separate synthetic serialization tests cover nested objects, arrays, numbers, booleans, and null values. Nested paths use dots, array elements use numeric segments, and literal dots and backslashes in JSON keys are escaped. These generic cases do not add fields to the AppFolio fixture.

Payload fields are included whenever the body was read, including signature rejections. Invalid JSON or invalid UTF-8 produces `payload.parse_error: invalid_json` instead of a raw string. Requests rejected before reading the body, and body-read failures, omit payload properties.

Payload logging accepts bodies up to 64 KiB before decoding, paths up to 32 levels below `payload`, and at most 512 fields. Traversal also has a 64 KiB budget for cumulative escaped UTF-8 path bytes and JSON-encoded leaf values, including paths to intermediate containers. This budget bounds expansion before allocating child paths. OTLP framing adds bytes to the exported record. If any limit is exceeded, the log keeps outcome and diagnostic fields and discards all payload properties. These limits do not change signature verification, forwarding, or analytics.

Run `pnpm exec vitest run tests/webhook-logging.test.ts` for a webhook integration check. It verifies signed forwarding, bounded unsigned-request logs, stage diagnostics, and concurrent signing-key waits through real OTLP export against local HTTP endpoints.

Create the client once per isolate. After writing each webhook response, the route registers `waitUntil(telemetry.flush())` using [`@vercel/functions`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package#waituntil). The handler returns without awaiting telemetry, while the registered promise awaits both `analytics.flush()` and `logs.forceFlush()` to settlement. There is no outer flush timer that abandons an export. The analytics `requestTimeout`, OTLP `timeoutMillis`, and batch processor `exportTimeoutMillis` all use `POSTHOG_FLUSH_TIMEOUT_MS` (2,000 ms). That budget applies per export; queued exports can take longer overall. Vercel still limits background work to the function duration.

Logs batch up to 64 records, each scrubbed before enqueueing. Overlapping log flushes are serialized so records captured during an earlier export get a subsequent drain. Flush failures never change the HTTP response. A rejected pipeline writes `telemetry_flush_failed analytics rejected` or `telemetry_flush_failed logs rejected` to stdout without the error text. Reserve `await telemetry.shutdown()` for process exit; its waiter is capped at 2,000 ms, and the request path never calls it.

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
pnpm run lint
pnpm run format:check
pnpm run typecheck
pnpm test
pnpm dlx vercel dev   # after setting env (vercel env pull or .env)
```

CI runs lint, formatting, type checks, and tests. Use `pnpm run lint:fix` to apply available ESLint fixes and `pnpm run format` to format files with Prettier. Generated files and the locked design document are excluded from formatting.

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
