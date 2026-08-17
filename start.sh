#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Primary product entry: synchronize the dependency graph before starting the
# formal Runtime-backed AgentLoop. This prevents a git pull from launching new
# Runtime Host code against an older node_modules tree.
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --frozen-lockfile
  exec pnpm run desktop:dev
fi

if command -v npm >/dev/null 2>&1; then
  npm ci
  exec npm run desktop:dev
fi

printf '%s\n' "Agent Workspace requires pnpm or npm to install dependencies." >&2
exit 127
