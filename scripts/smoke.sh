#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_BIN="${ROOT}/release/macos/Light.app/Contents/MacOS/Light"
HOOK_BIN="${ROOT}/release/macos/Light.app/Contents/MacOS/light-hook"

if [[ ! -x "${APP_BIN}" || ! -x "${HOOK_BIN}" ]]; then
  "${ROOT}/scripts/build.sh" release
fi

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/light-smoke.XXXXXX")"
OUT_LOG="${TMP_DIR}/stdout.log"
ERR_LOG="${TMP_DIR}/stderr.log"
APP_PID=""
SECOND_PID=""

cleanup() {
  for pid in "${SECOND_PID}" "${APP_PID}"; do
    if [[ -n "${pid}" ]]; then
      kill "${pid}" 2>/dev/null || true
      wait "${pid}" 2>/dev/null || true
    fi
  done
  rm -rf "${TMP_DIR}"
}
trap cleanup EXIT

echo "==> Launching Light.app in --smoke-test mode..."
export LIGHT_PORT=0 LIGHT_DATA_DIR="${TMP_DIR}/data" LIGHT_TEST_HOME="${TMP_DIR}/home"
"${APP_BIN}" --smoke-test >"${OUT_LOG}" 2>"${ERR_LOG}" &
APP_PID=$!

PORT=""
UI_OK=""
for _ in $(seq 1 50); do
  if ! kill -0 "${APP_PID}" 2>/dev/null; then
    echo "FAIL: Light exited prematurely" >&2
    cat "${ERR_LOG}" >&2
    exit 1
  fi
  if [[ -z "${PORT}" ]]; then
    PORT="$(sed -n 's/^LIGHT_TEST_PORT=//p' "${OUT_LOG}" | head -n 1 || true)"
  fi
  if [[ -z "${UI_OK}" ]]; then
    UI_OK="$(sed -n 's/^LIGHT_SMOKE_UI_OK=//p' "${OUT_LOG}" | head -n 1 || true)"
  fi
  if [[ -n "${PORT}" && -n "${UI_OK}" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -z "${PORT}" || -z "${UI_OK}" ]]; then
  echo "FAIL: timed out waiting for smoke markers (PORT=${PORT}, UI_OK=${UI_OK})" >&2
  cat "${OUT_LOG}" >&2
  cat "${ERR_LOG}" >&2
  exit 1
fi

sed -n 's/^LIGHT_SMOKE_WIDTHS=/Capsule widths (pt): /p' "${OUT_LOG}"
echo "==> Light listening on 127.0.0.1:${PORT}, UI self-check passed"

echo "==> Checking a second instance sharing the data directory..."
"${APP_BIN}" --smoke-test >"${TMP_DIR}/second.log" 2>&1 &
SECOND_PID=$!
for _ in $(seq 1 50); do
  if grep -qx 'LIGHT_TEST_READ_ONLY=1' "${TMP_DIR}/second.log"; then break; fi
  if ! kill -0 "${SECOND_PID}" 2>/dev/null; then break; fi
  sleep 0.1
done
if ! grep -qx 'LIGHT_TEST_READ_ONLY=1' "${TMP_DIR}/second.log"; then
  echo "FAIL: second instance did not enter read-only mode" >&2
  cat "${TMP_DIR}/second.log" >&2
  exit 1
fi
kill "${SECOND_PID}"
wait "${SECOND_PID}" 2>/dev/null || true
SECOND_PID=""

echo "==> Checking /health..."
curl -sf "http://127.0.0.1:${PORT}/health" | grep -q '"ok":true'

echo "==> Sending event via bundled light-hook..."
printf '{"session_id":"99999999-2222-3333-4444-555555555555","prompt":"smoke test prompt","cwd":"/tmp"}\n' \
  | LIGHT_PORT="${PORT}" "${HOOK_BIN}" claude user_prompt

echo "==> Checking /state contains ingested session..."
curl -sf "http://127.0.0.1:${PORT}/state" | grep -q 'smoke test prompt'

echo "==> Measuring live memory footprint (PID ${APP_PID})..."
vmmap -summary "${APP_PID}" 2>/dev/null | grep -E "Physical footprint" || true

echo "==> Smoke test PASSED"
