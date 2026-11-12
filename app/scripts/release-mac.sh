#!/bin/sh
# Signed (+ notarized) Mac installer to share: app/dist/Lynote-NoteTaker-mac-arm64.dmg
# Needs your Developer ID certificate in the keychain, named in YOGURT_SIGN_ID ("Name (TEAMID)"), and, to notarize,
# a notarytool profile:
#   xcrun notarytool store-credentials yogurt-notary --apple-id <Apple ID> --team-id <TEAMID>
# YOGURT_NOTARIZE=0 signs and checks without sending anything to Apple (a build to try on this Mac).
# YOGURT_FUSES=0 leaves Electron's fuses as they come (the inspector on), for the local debugging only: never share it.
# Builds into dist/ only: with another output folder electron-builder packs the whole project.
# To build while a copy from dist/ is running, run this in a separate checkout (git worktree).
set -e
ID="${YOGURT_SIGN_ID:?set YOGURT_SIGN_ID to your Developer ID identity, like 'Name (TEAMID)', or to 'Yogurt Local'}"
# the team every program inside must be signed by: given, or the one in brackets at the end of the identity
TEAM="${YOGURT_TEAM_ID:-$(printf %s "$ID" | sed -n 's/.*(\([A-Z0-9]*\))$/\1/p')}"
LOCAL=0
if [ "$ID" = 'Yogurt Local' ]; then
  [ "${YOGURT_NOTARIZE:-1}" = 0 ] || { echo 'Yogurt Local requires YOGURT_NOTARIZE=0' >&2; exit 1; }
  LOCAL=1
fi
[ "$LOCAL" = 1 ] || [ -n "$TEAM" ] || { echo 'YOGURT_SIGN_ID has no team id in brackets: set YOGURT_TEAM_ID' >&2; exit 1; }
cd "$(dirname "$0")/.."
PROFILE="${YOGURT_NOTARY_PROFILE:-yogurt-notary}"
APP="dist/mac-arm64/Lynote NoteTaker.app"
set --
if [ "$LOCAL" = 1 ]; then
  # Pin the exact certificate; never silently fall back to ad-hoc or a different signer.
  CERT=$(security find-identity -v -p codesigning | awk '/"Yogurt Local"$/ { print $2 }')
  [ "${#CERT}" = 40 ] || { echo 'Create exactly one valid Yogurt Local code-signing identity.' >&2; exit 1; }
  LOCAL_DIR=$(mktemp -d "${TMPDIR:-/tmp}/yogurt-local-sign.XXXXXX")
  trap 'rm -rf "$LOCAL_DIR"' EXIT
  for ent in mac mac.inherit; do
    cp "build/entitlements.$ent.plist" "$LOCAL_DIR/$ent.plist"
    # Without an Apple Team ID, library validation rejects Electron's native libraries.
    /usr/libexec/PlistBuddy -c 'Add :com.apple.security.cs.disable-library-validation bool true' "$LOCAL_DIR/$ent.plist"
  done
  node - "$LOCAL_DIR" <<'JS' > "$LOCAL_DIR/config.json"
const path = require('node:path')
const dir = process.argv[2]
console.log(JSON.stringify({ extends: path.resolve('electron-builder.yml'), publish: null, forceCodeSigning: true,
  mac: { identity: 'Yogurt Local', notarize: false, entitlements: path.join(dir, 'mac.plist'),
    entitlementsInherit: path.join(dir, 'mac.inherit.plist') } }))
JS
  set -- --config "$LOCAL_DIR/config.json"
fi
rm -rf dist
sh scripts/native.sh
npx electron-vite build
EXTRA=""
# Electron's own defaults, fuse by fuse (the config file sets them; -c can't remove a setting)
[ "${YOGURT_FUSES:-1}" = 0 ] && EXTRA="-c.electronFuses.runAsNode=true -c.electronFuses.enableNodeOptionsEnvironmentVariable=true -c.electronFuses.enableNodeCliInspectArguments=true -c.electronFuses.onlyLoadAppFromAsar=false -c.electronFuses.enableEmbeddedAsarIntegrityValidation=false"
CSC_NAME="$ID" npx electron-builder --mac --publish never "$@" $EXTRA
# the app holds only the built code: a source folder inside means the build settings weren't applied
node scripts/asar-check.mjs "$APP/Contents/Resources/app.asar"
# the packaged notes engine starts and loads its dependencies (a local build is checked on release CI instead)
if [ "$LOCAL" = 0 ]; then npx electron scripts/engine-smoke.cjs "$APP/Contents/Resources/app.asar"; fi
codesign --verify --deep --strict "$APP"
verify_identity() {
  if [ "$LOCAL" = 1 ]; then
    codesign --verify --strict -R="certificate leaf = H\"$CERT\"" "$1"
    dr=$(codesign -d -r- "$1" 2>&1)
    echo "$dr" | grep -q 'designated =>' || { echo "$1 has no designated requirement" >&2; exit 1; }
    echo "$dr" | grep -q 'cdhash' && { echo "$1 has an unstable ad-hoc requirement" >&2; exit 1; }
  else
    codesign -dv "$1" 2>&1 | grep -q "TeamIdentifier=$TEAM" || { echo "$1 isn't signed with the Developer ID" >&2; exit 1; }
  fi
  return 0
}
# Main and helpers use one certificate, with hardened runtime and helper-specific entitlements.
for h in "$APP" "$APP"/Contents/Resources/bin/*; do
  verify_identity "$h"
  info=$(codesign -dv "$h" 2>&1)
  echo "$info" | grep -q "runtime" || { echo "$h has no hardened runtime" >&2; exit 1; }
done
codesign -d --entitlements - "$APP/Contents/Resources/bin/yogurt-audio" 2>/dev/null | grep -q device.audio-input || { echo "yogurt-audio can't use the microphone" >&2; exit 1; }
if [ "${YOGURT_FUSES:-1}" != 0 ]; then
  pnpm exec electron-fuses read --app "$APP" | grep -q "RunAsNode is Disabled" || { echo "Electron's fuses aren't set" >&2; exit 1; }
fi
DMG=dist/Lynote-NoteTaker-mac-arm64.dmg
# electron-builder signed the disk image too (dmg.sign); signing it again here would change it after latest-mac.yml
verify_identity "$DMG"
if [ "$LOCAL" = 1 ]; then
  [ ! -e "$APP/Contents/Resources/app-update.yml" ] || { echo 'Local builds must not have a release feed' >&2; exit 1; }
  [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$APP/Contents/Info.plist")" = ai.lynote.notetaker ] || exit 1

fi
if [ "${YOGURT_NOTARIZE:-1}" = 0 ]; then
  echo "Signed, not notarized: $(pwd)/$DMG"
  exit 0
fi
xcrun notarytool submit "$DMG" --keychain-profile "$PROFILE" --wait
xcrun stapler staple "$DMG"
xcrun stapler staple "$APP"
# stapling changed the disk image: its checksum in latest-mac.yml again
node scripts/refresh-latest.mjs dist/latest-mac.yml
spctl -a -t open --context context:primary-signature -vv "$DMG"
echo "Ready to share: $(pwd)/$DMG"
