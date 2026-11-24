#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
"${ROOT}/scripts/build.sh" debug
exec "${ROOT}/.build/dev/Light.app/Contents/MacOS/Light" "$@"
