#!/bin/sh
# A new Yogurt for Mac, Windows and Linux: sh app/scripts/release.sh 0.3.0
# Sets the version, commits, tags v0.3.0 and pushes. GitHub Actions (.github/workflows/release.yml) builds all three,
# signs and notarizes the Mac, and publishes one release once all three built; the download links and installed
# copies pick it up from there.
#
# sh app/scripts/release.sh 0.3.0 --mac-local: use this Mac’s signing credentials. Sets the version, builds the
# signed, notarized Mac here (release-mac.sh), commits and pushes main (no tag), puts the Mac in a draft release at that
# commit and starts release.yml to add Windows and Linux to the draft. Nothing is published: check the draft, then
#   gh release edit v0.3.0 --draft=false --latest
# Run it in a checkout no Yogurt from app/dist/ is running from (release-mac.sh rebuilds dist/ and the helpers).
set -e
cd "$(dirname "$0")/../.."
VERSION="$1"
MODE="$2"
echo "$VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "usage: sh app/scripts/release.sh 1.2.3 [--mac-local]" >&2; exit 1; }
[ -z "$MODE" ] || [ "$MODE" = --mac-local ] || { echo "usage: sh app/scripts/release.sh 1.2.3 [--mac-local]" >&2; exit 1; }
[ "$(git branch --show-current)" = main ] || { echo "release from main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "commit or stash your changes first" >&2; exit 1; }
git pull -q --ff-only
# the repository origin points at, so links and gh follow it
REPO_URL=$(git remote get-url origin | sed -E 's#^git@github.com:#https://github.com/#; s#\.git$##')
git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null && { echo "v$VERSION already exists" >&2; exit 1; }
# a release always moves forward, so installed copies see it as an update
node -e '
const cur = require("./app/package.json").version.split(".").map(Number), next = process.argv[1].split(".").map(Number)
const d = next.map((n, i) => n - cur[i]).find((n) => n !== 0)
if (!(d > 0)) { console.error(`${process.argv[1]} must be newer than ${cur.join(".")}`); process.exit(1) }
' "$VERSION"
if [ "$MODE" = --mac-local ]; then
  command -v gh >/dev/null || { echo "--mac-local needs the GitHub CLI (gh)" >&2; exit 1; }
  gh release view "v$VERSION" >/dev/null 2>&1 && { echo "a release v$VERSION exists already" >&2; exit 1; }
fi
node -e '
const fs = require("fs"); const p = "app/package.json"; const j = JSON.parse(fs.readFileSync(p, "utf8"))
j.version = process.argv[1]; fs.writeFileSync(p, JSON.stringify(j, null, 2) + "\n")
' "$VERSION"

if [ "$MODE" != --mac-local ]; then
  git commit -qm "Yogurt $VERSION" app/package.json
  git tag "v$VERSION"
  git push -q origin main "v$VERSION"
  echo "Building Yogurt $VERSION: $REPO_URL/actions/workflows/release.yml"
  if command -v gh >/dev/null; then
    sleep 15
    gh run watch --exit-status "$(gh run list --workflow release.yml --branch "v$VERSION" --limit 1 --json databaseId --jq '.[0].databaseId')" >/dev/null
    echo "Published: $REPO_URL/releases/tag/v$VERSION"
  fi
  exit 0
fi

# the Mac is built before anything is committed: if it fails, the version goes back and nothing was pushed
trap 'git checkout -q app/package.json' EXIT
sh app/scripts/release-mac.sh
D=app/dist
# only a notarized Developer ID build goes in a release
xcrun stapler validate "$D/Yogurt-mac-arm64.dmg"
codesign -dv "$D/mac-arm64/Yogurt.app" 2>&1 | grep -q 'TeamIdentifier=2JNSQVN3N8' || { echo "the app isn't signed with the Developer ID" >&2; exit 1; }
trap - EXIT
git commit -qm "Yogurt $VERSION" app/package.json
git push -q origin main
SHA=$(git rev-parse HEAD)
gh release create "v$VERSION" --draft --target "$SHA" --title "Yogurt $VERSION" --generate-notes \
  "$D/Yogurt-mac-arm64.dmg" "$D/Yogurt-mac-arm64.dmg.blockmap" "$D/Yogurt-mac-arm64.zip" "$D/Yogurt-mac-arm64.zip.blockmap" "$D/latest-mac.yml"
gh workflow run release.yml --ref main -f draft="v$VERSION"
echo "Building Windows and Linux for the draft: $REPO_URL/actions/workflows/release.yml"
sleep 15
gh run watch --exit-status "$(gh run list --workflow release.yml --limit 10 --json databaseId,event --jq 'map(select(.event == "workflow_dispatch"))[0].databaseId')" >/dev/null
gh release view "v$VERSION" --json assets --jq '.assets[].name'
echo "Check the draft, then publish it: gh release edit v$VERSION --draft=false --latest"
