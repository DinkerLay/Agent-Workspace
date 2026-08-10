#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Primary product entry: the formal Runtime-backed AgentLoop. The launcher
# starts one authenticated Runtime Host, the formal Workbench Vite root, and
# the formal Electron shell.
if command -v pnpm >/dev/null 2>&1; then
  exec pnpm run desktop:dev
fi

exec npm run desktop:dev
