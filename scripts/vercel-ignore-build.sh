#!/bin/sh
# Vercel ignoreCommand: exit 0 skips the build, exit 1 runs it.
set -u

if [ "${VERCEL_ENV:-}" != "production" ]; then
  exit 1
fi

if printf '%s\n' "${VERCEL_GIT_COMMIT_MESSAGE:-}" | tr -d '\r' | grep -Eq '^chore\(main\): release [0-9]+\.[0-9]+\.[0-9]+( \(#[0-9]+\))?$'; then
  exit 1
fi

exit 0
