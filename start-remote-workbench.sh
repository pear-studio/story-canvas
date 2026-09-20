#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "$0")" && pwd)"
cd -- "$repo_root"
tailscale serve --bg 3000
exec node "$repo_root/app/scripts/start-workbench.mjs" production --build --replace
