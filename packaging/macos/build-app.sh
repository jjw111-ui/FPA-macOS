#!/usr/bin/env bash
set -euo pipefail

VERSION="1.0.0"
OUTPUT_DIR="dist-macos"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -v|--version) VERSION="$2"; shift 2 ;;
    -o|--output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "FPA macOS packages must be built on macOS." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOST_ARCH="$(uname -m)"
case "$HOST_ARCH" in
  arm64) PACKAGE_ARCH="arm64"; SHARP_ARCH="arm64" ;;
  x86_64) PACKAGE_ARCH="x64"; SHARP_ARCH="x64" ;;
  *) echo "Unsupported macOS architecture: ${HOST_ARCH}" >&2; exit 1 ;;
esac

if [[ "$OUTPUT_DIR" = /* ]]; then
  BUILD_ROOT="$OUTPUT_DIR"
else
  BUILD_ROOT="${PROJECT_ROOT}/${OUTPUT_DIR}"
fi

SAFE_VERSION="$(printf '%s' "$VERSION" | sed -E 's/[^A-Za-z0-9_.-]+/-/g; s/^-+//; s/-+$//')"
[[ -n "$SAFE_VERSION" ]] || SAFE_VERSION="dev"
PLIST_VERSION="$(printf '%s' "$VERSION" | sed -E 's/[^0-9.]+/./g; s/^\.+//; s/\.+$//; s/\.{2,}/./g')"
[[ -n "$PLIST_VERSION" ]] || PLIST_VERSION="1.0.0"

APP_NAME="FPA.app"
APP_ROOT="${BUILD_ROOT}/${APP_NAME}"
CONTENTS="${APP_ROOT}/Contents"
MACOS_DIR="${CONTENTS}/MacOS"
RESOURCES="${CONTENTS}/Resources"
APP_DIR="${RESOURCES}/app"
NODE_DIR="${RESOURCES}/node/bin"
DMG_STAGE="${BUILD_ROOT}/dmg-stage"
DMG_PATH="${BUILD_ROOT}/FPA-macOS-${PACKAGE_ARCH}-${SAFE_VERSION}.dmg"
HASH_PATH="${DMG_PATH}.sha256.txt"
MANIFEST_PATH="${BUILD_ROOT}/macos-app-build.json"

command -v node >/dev/null
command -v npm >/dev/null
command -v swiftc >/dev/null
command -v hdiutil >/dev/null

cd "$PROJECT_ROOT"
npm ci --no-audit --no-fund
npm run build

rm -rf "$APP_ROOT" "$DMG_STAGE"
rm -f "$DMG_PATH" "$HASH_PATH" "$MANIFEST_PATH"
mkdir -p "$MACOS_DIR" "$APP_DIR/scripts" "$APP_DIR/src" "$APP_DIR/node_modules/@img" "$NODE_DIR" "$DMG_STAGE"

cp -R dist "$APP_DIR/dist"
for file in portable-server.mjs studio-api.mjs import-job-api.mjs image-input.mjs design-api.mjs design-generation-api.mjs design-output-settings.mjs quiver-api.mjs typesafe-search.mjs asset-labels.mjs; do
  cp "scripts/${file}" "$APP_DIR/scripts/${file}"
done
for file in output-settings.mjs image-limits.mjs asset-search.mjs; do
  cp "src/${file}" "$APP_DIR/src/${file}"
done
cp package.json LICENSE "$APP_DIR/"

for package in sharp detect-libc semver; do
  cp -R "node_modules/${package}" "$APP_DIR/node_modules/${package}"
done
for package in colour "sharp-darwin-${SHARP_ARCH}" "sharp-libvips-darwin-${SHARP_ARCH}"; do
  if [[ ! -d "node_modules/@img/${package}" ]]; then
    echo "Missing native macOS dependency: @img/${package}" >&2
    exit 1
  fi
  cp -R "node_modules/@img/${package}" "$APP_DIR/node_modules/@img/${package}"
done

cp "$(command -v node)" "$NODE_DIR/node"
chmod +x "$NODE_DIR/node"
swiftc -O -framework Cocoa "${SCRIPT_DIR}/FPAApp.swift" -o "$MACOS_DIR/FPA"
chmod +x "$MACOS_DIR/FPA"
lipo -archs "$NODE_DIR/node" | grep -qw "$HOST_ARCH"
lipo -archs "$MACOS_DIR/FPA" | grep -qw "$HOST_ARCH"

cat > "$CONTENTS/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>FPA</string>
  <key>CFBundleExecutable</key><string>FPA</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>com.fpa.designpartner</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>FPA</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${PLIST_VERSION}</string>
  <key>CFBundleVersion</key><string>${PLIST_VERSION}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
PLIST
plutil -lint "$CONTENTS/Info.plist" >/dev/null

ICON_WORK="${BUILD_ROOT}/AppIcon.iconset"
ICON_SOURCE="${BUILD_ROOT}/AppIcon-1024.png"
rm -rf "$ICON_WORK"
mkdir -p "$ICON_WORK"
sips -s format png -z 1024 1024 "public/icon.svg" --out "$ICON_SOURCE" >/dev/null
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$ICON_SOURCE" --out "${ICON_WORK}/icon_${size}x${size}.png" >/dev/null
  retina=$((size * 2))
  sips -z "$retina" "$retina" "$ICON_SOURCE" --out "${ICON_WORK}/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICON_WORK" -o "$RESOURCES/AppIcon.icns"

printf '%s\n' "$VERSION" > "$RESOURCES/app-version.txt"
cp LICENSE "$RESOURCES/LICENSE"
cp "${SCRIPT_DIR}/README.md" "$RESOURCES/README.md"

codesign --force --deep --sign - "$APP_ROOT" >/dev/null
codesign --verify --deep --strict "$APP_ROOT"

ditto "$APP_ROOT" "$DMG_STAGE/$APP_NAME"
ln -s /Applications "$DMG_STAGE/Applications"
hdiutil create -volname "FPA" -srcfolder "$DMG_STAGE" -ov -format UDZO "$DMG_PATH"

SHA256="$(shasum -a 256 "$DMG_PATH" | awk '{print $1}')"
printf '%s  %s\n' "$SHA256" "$(basename "$DMG_PATH")" > "$HASH_PATH"
cat > "$MANIFEST_PATH" <<JSON
{
  "project": "FPA-macOS",
  "version": "${VERSION}",
  "architecture": "${PACKAGE_ARCH}",
  "minimum_macos": "12.0",
  "bundle": "${APP_NAME}",
  "dmg": "$(basename "$DMG_PATH")",
  "sha256": "${SHA256}",
  "data_dir": "~/Library/Application Support/FPA"
}
JSON

echo "Built ${DMG_PATH}"
echo "SHA256 ${SHA256}"
