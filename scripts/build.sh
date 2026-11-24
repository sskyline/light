#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="${1:-release}"
VERSION="${LIGHT_VERSION:-1.2.0}"
OUT_DIR="${ROOT}/release/macos"
if [[ "${CONFIG}" == debug ]]; then
  OUT_DIR="${ROOT}/.build/dev"
fi
APP_DIR="${OUT_DIR}/Light.app"
ASSETS_DIR="${ROOT}/Resources"

cd "${ROOT}"
BUILD_ARGS=(-c "${CONFIG}")
if [[ "${CONFIG}" == debug ]]; then
  # SwiftPM can spend seconds planning even when every input is unchanged.
  INPUTS_FILE="${OUT_DIR}/build-inputs"
  INPUTS="$(
    {
      swift --version
      xcrun --sdk macosx --show-sdk-build-version
      printf '%s\n' "${ROOT}" "${VERSION}" "${DEVELOPER_DIR:-}" "${TOOLCHAINS:-}" "${SDKROOT:-}" "${SWIFT_EXEC:-}"
      shasum Package*.swift scripts/build.sh
      if [[ -f Package.resolved ]]; then shasum Package.resolved; fi
      find -L Sources tests/LightCoreTests -type f -exec shasum {} + | LC_ALL=C sort
      if [[ -d "${ASSETS_DIR}" ]]; then
        find -L "${ASSETS_DIR}" -type f -exec shasum {} + | LC_ALL=C sort
      fi
    } | shasum
  )"
  if [[ -f "${INPUTS_FILE}" && "$(<"${INPUTS_FILE}")" == "${INPUTS}" &&
        -x "${APP_DIR}/Contents/MacOS/Light" && -x "${APP_DIR}/Contents/MacOS/light-hook" ]] &&
     codesign --verify "${APP_DIR}" 2>/dev/null; then
    echo "==> Using existing Debug app."
    exit 0
  fi

  echo "==> Building Swift targets (debug)..."
  swift build "${BUILD_ARGS[@]}"
else
  echo "==> Building Swift targets (${CONFIG})..."
  swift build -c "${CONFIG}" --product Light
  swift build -c "${CONFIG}" --product light-hook
fi
BIN_DIR="$(swift build "${BUILD_ARGS[@]}" --show-bin-path)"
LIGHT_BIN="${BIN_DIR}/Light"
HOOK_BIN="${BIN_DIR}/light-hook"

if [[ ! -x "${LIGHT_BIN}" || ! -x "${HOOK_BIN}" ]]; then
  echo "Error: could not locate built binaries in ${BIN_DIR}" >&2
  exit 1
fi

echo "==> Assembling ${APP_DIR}..."
rm -rf "${APP_DIR}"
mkdir -p "${APP_DIR}/Contents/MacOS" "${APP_DIR}/Contents/Resources"

cp "${LIGHT_BIN}" "${APP_DIR}/Contents/MacOS/Light"
cp "${HOOK_BIN}" "${APP_DIR}/Contents/MacOS/light-hook"
chmod 755 "${APP_DIR}/Contents/MacOS/Light" "${APP_DIR}/Contents/MacOS/light-hook"

if [[ -f "${ASSETS_DIR}/light.icns" ]]; then
  cp "${ASSETS_DIR}/light.icns" "${APP_DIR}/Contents/Resources/light.icns"
fi

if [[ -f "${ASSETS_DIR}/tray-icon-macTemplate.png" && -f "${ASSETS_DIR}/tray-icon-macTemplate@2x.png" ]]; then
  tiffutil -cathidpicheck \
    "${ASSETS_DIR}/tray-icon-macTemplate.png" \
    "${ASSETS_DIR}/tray-icon-macTemplate@2x.png" \
    -out "${APP_DIR}/Contents/Resources/tray.tiff" >/dev/null
elif [[ -f "${ASSETS_DIR}/tray-icon-macTemplate.png" ]]; then
  cp "${ASSETS_DIR}/tray-icon-macTemplate.png" "${APP_DIR}/Contents/Resources/tray.png"
fi

cat > "${APP_DIR}/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>zh_CN</string>
  <key>CFBundleDisplayName</key>
  <string>Light</string>
  <key>CFBundleExecutable</key>
  <string>Light</string>
  <key>CFBundleIconFile</key>
  <string>light</string>
  <key>CFBundleIdentifier</key>
  <string>com.light.app</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>Light</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>LSMinimumSystemVersion</key>
  <string>14.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSAppleEventsUsageDescription</key>
  <string>Light 需要自动化权限以定位并恢复 Ghostty / iTerm2 会话分屏。</string>
</dict>
</plist>
EOF

echo "==> Ad-hoc code signing..."
codesign --force --deep --sign - "${APP_DIR}" >/dev/null 2>&1 || true
if [[ "${CONFIG}" == debug ]]; then
  printf '%s\n' "${INPUTS}" > "${INPUTS_FILE}"
fi

SIZE="$(du -sh "${APP_DIR}" | awk '{print $1}')"
echo "==> Done: ${APP_DIR} (${SIZE})"
