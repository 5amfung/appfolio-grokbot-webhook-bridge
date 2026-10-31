# Webhook bridge verification map

This directory is the maintained source for verifying the user-facing HTTP behavior of the AppFolio to Grok Bot webhook bridge. Read the index, launch one bridge, run doctor, then follow the feature file for the behavior under test.

## Baseline preconditions

- Repository root, dependencies installed with `pnpm install --frozen-lockfile`, `vercel` and `lsof` and `curl` on `PATH`.
- One bridge started by `launch.mjs` for this checkout. Export `RUN_DIR`, `EVIDENCE_DIR`, and `BASE_URL` from its stdout.
- Doctor prints `ok` for that `RUN_DIR` before the first drive and after any failed drive.
- `$RUN_DIR/upstream-status` is `204` unless the upstream-failure recipe has not yet restored it.
- Never drive a `vercel dev` process this launch did not record.

## Driving conventions

- Start every recipe from the baseline unless its preconditions say otherwise.
- Send webhook bodies with `curl --data-binary @file`. Sign that same file.
- Treat commands as literal, including the single space in the fixture JSON.
- Count `$RUN_DIR/upstream-captures.jsonl` immediately before each POST that must not forward, and before each POST that must forward once.
- Write evidence under `$EVIDENCE_DIR/<feature-id>/`. Cleanup deletes `$RUN_DIR` only.
- An unreachable entry point is a failed drive. Report the command and the unmet precondition. Do not claim success through a different route.

## Proof and skip reporting

- Capture the request and the resulting state, not only the final status code.
- Health proof is the status line and the body `{"ok":true}`.
- Rejection proof is the status, the JSON error, and an unchanged capture count.
- Forward proof is `proof.json` showing the upstream body, `Bearer` authorization, and `application/json` content type matched, plus the bridge status and body.
- Record the feature id in the evidence directory name.
- Do not copy the bearer token into evidence. It lives in `$RUN_DIR/meta.json` until cleanup.

## Feature entry contract

Each feature file starts with an H1 and one paragraph, then exactly these H2 sections: `Sub-features`, `How to get to it (user POV)`, `Driving it with the HTTP harness`, `Gotchas`.

## Features

- [Health](./health.md) covers `GET /api/health`.
- [Reject a webhook](./reject-webhook.md) covers a missing signature, a malformed signature, and a body that does not match the signature.
- [Forward a signed webhook](./forward-webhook.md) covers a valid detached signature and the raw body arriving upstream.
- [Upstream failure](./upstream-failure.md) covers a valid signature when the bot returns HTTP 500.
- [Method not allowed](./method-not-allowed.md) covers `GET` and `PUT` on the webhook route.
