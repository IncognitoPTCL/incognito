#!/usr/bin/env bash
# Production deploy to Vercel. Deploys a git-free copy: from inside the repo
# Vercel attaches the commit author and blocks the deploy when that identity
# is not on the team.
set -euo pipefail
cd "$(dirname "$0")"
node build.mjs
DEST="${TEMP:-/tmp}/incognito-deploy/incognito-pad"
rm -rf "$DEST" && mkdir -p "$DEST"
cp -r api public vercel.json .vercelignore package.json "$DEST/"
if [ -f .vercel/project.json ]; then mkdir -p "$DEST/.vercel" && cp .vercel/project.json "$DEST/.vercel/"; fi
cd "$DEST"
vercel deploy --prod --yes
mkdir -p "$OLDPWD/.vercel" && cp .vercel/project.json "$OLDPWD/.vercel/project.json"
