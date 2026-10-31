---
name: verify-appfolio-grokbot-webhook-bridge
description: >-
  Drive the AppFolio to Grok Bot webhook bridge over local HTTP and prove
  health, JWS rejection, signed forward, and upstream failure. Use when
  verifying this service, proving a webhook or health change, or exercising
  GET /api/health or POST /api/webhooks/appfolio.
---

# Verify the webhook bridge

The user-facing surface is HTTP. An operator calls `GET /api/health`. AppFolio calls `POST /api/webhooks/appfolio` with a detached PS256 `X-JWS-Signature`. This skill launches that service with `vercel dev --local`, signs fixtures with a local key, and records what the bridge forwards.

Run every command from the repository root. Drive one long-lived bridge per checkout. Run doctor before the first drive and again after any failed drive. Never drive a process this launch did not start.

## Launch

Preconditions: Node `>= 20`, `npm ci` already run, `vercel` and `lsof` and `curl` on `PATH`. `package.json` must not have a `scripts.dev` that invokes `vercel dev` (the CLI aborts that as a recursive invocation). `.env` and `.env.build` must not assign `GROK_BOT_WEBHOOK_URL`, `GROK_BOT_BEARER_TOKEN`, or `APPFOLIO_JWKS_URL`; `vercel dev` loads those files over the process environment.

```bash
node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/launch.mjs
```

Export the printed values before doing anything else:

```text
RUN_DIR=...
EVIDENCE_DIR=...
BASE_URL=http://127.0.0.1:<port>
META=<run dir>/meta.json
```

`RUN_DIR` and `EVIDENCE_DIR` default under `${TMPDIR:-/tmp}/verify-appfolio-grokbot-webhook-bridge/<run-id>/` as sibling `run` and `evidence` directories, outside the repo. Override both `VERIFY_RUN_DIR` and `VERIFY_EVIDENCE_DIR`, or neither. `VERIFY_RUN_DIR` must be a new empty directory. Launch rejects the repo, anything inside it, and any ancestor of it, including through a symlink. Cleanup deletes a run directory only when it contains this harness's sentinel and `meta.json` names that same directory. Optional: `VERIFY_ROOT`, `VERIFY_RUN_ID`, `VERCEL_BIN`.

Launch starts a local JWKS and capture server, then:

```text
vercel dev --local --listen 127.0.0.1:<port> --yes
```

with `GROK_BOT_WEBHOOK_URL`, `GROK_BOT_BEARER_TOKEN` (`crsr_verify_` plus random hex), and `APPFOLIO_JWKS_URL` set only on that child. It does not write `.env`. The vercel log is `$RUN_DIR/vercel.log` and includes `Ready! Available at http://127.0.0.1:<port>`. Launch stays up until `GET $BASE_URL/api/health` returns `200` `{"ok":true}` and an unsigned `POST $BASE_URL/api/webhooks/appfolio` returns `401` `{"error":"missing X-JWS-Signature header"}` without an upstream capture. Exit `0` means that usable state. Exit `2` means this checkout already has a verification bridge (`.vercel/verify-bridge.lock`).

One `launch.mjs` per checkout. `vercel dev` can bind two ports here; this harness still refuses the second launch so the JWKS, bearer token, and capture log stay tied to one run. Another git worktree has its own lock and can launch beside this one. On any launch failure, run cleanup on the printed `RUN_DIR`.

Local proof does not log in, link a Vercel project, pull project env, call `https://api.appfolio.com/.well-known/jwks.json`, or call Grok Bot. Those stay unverified until a run against that target. The routes under test are the real `api/health.ts` and `api/webhooks/appfolio.ts` handlers.

## Doctor

Read-only. Answers whether this bridge is worth driving: both recorded pids are alive, `lsof` shows `bridgePort` owned by the bridge pid, upstream status file is `204`, JWKS serves the `verify-bridge` PS256 public key and no private material, `GET` of the capture URL returns `404`, health is `200` `{"ok":true}`, and an unsigned POST returns `401` with the missing-signature body without appending a capture.

```bash
node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/doctor.mjs --run-dir "$RUN_DIR"
```

Stdout starts with `ok` or stderr starts with `not-ok:`. If upstream status is not `204`, write `204` to `$RUN_DIR/upstream-status` and run doctor again before driving. Do not drive a `not-ok` instance.

## Drive

User entry points are the routes in `features/`. Prefer those recipes over ad-hoc requests. Sign the exact file you send. `POST` with `--data-binary @file` and header `X-JWS-Signature`. Count `$RUN_DIR/upstream-captures.jsonl` before the request and pass that count to `prove-webhook.mjs`. A bridge `200` is not proof of a forward; the proof file must show the capture bytes, `Bearer` token, and `content-type: application/json` matched.

Stable files in `$RUN_DIR`: `private.jwk`, `upstream-captures.jsonl`, `upstream-status` (`204` unless a recipe temporarily changes it).

## Evidence

Write under `$EVIDENCE_DIR/<feature-id>/`. Keep the request body, curl `-D` headers, response body, and `proof.json`. Record the feature id in the directory name. Proof of a forward is `bodiesMatch`, `authorizationMatch`, `contentTypeMatch`, and `upstreamStatusMatch` all true, plus the bridge status and body. Proof of a rejection is the bridge status and body with `capturesAfter === capturesBefore`. Do not treat a mock's name as proof: the capture file is the observation. The bearer token stays in `$RUN_DIR/meta.json` and must not be copied into evidence.

## Cleanup

Kill the recorded process groups only, delete `.vercel/verify-bridge.lock` when it points at this run, and delete `$RUN_DIR`. Leave `$EVIDENCE_DIR` in place.

```bash
node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/cleanup.mjs --run-dir "$RUN_DIR"
```

Stdout includes `evidence remains <path>`. Then confirm a proof file from this run is still at that path. After a failed launch or drive, clean up before starting another bridge.

## Helpers

- `node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/launch.mjs`
- `node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/doctor.mjs --run-dir "$RUN_DIR"`
- `node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/sign-detached.mjs --private-jwk "$RUN_DIR/private.jwk" --body-file <file>`
- `node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/prove-webhook.mjs --run-dir "$RUN_DIR" --response-body <file> --response-headers <file> --captures-before <n> --expect-status <n> --expect-forward true|false --out <proof.json>` plus `--body-file` and `--expect-upstream-status` when forwarding, optional `--expect-body` and repeatable `--expect-header Name: value`
- `node .cursor/skills/verify-appfolio-grokbot-webhook-bridge/scripts/cleanup.mjs --run-dir "$RUN_DIR"`

`boundaries.mjs` is started by launch, not invoked on its own.
