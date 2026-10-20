#!/usr/bin/env bash
# Build the deployment bundle ON THE SERVER.
#
# This is the recommended way to deploy to shared hosting (cPanel / StackCP):
# the bundle is built with the server's own Node.js and OS, so the Prisma
# query engine matches the platform and the app actually starts.
#
# Usage (over SSH, from the project directory):
#     bash scripts/build-on-host.sh
#
# Then:
#     cp .env.example .env   # and edit it
#     npx prisma migrate deploy
#     bash deploy/start.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

echo "==> Node $(node -v), npm $(npm -v)"

echo "==> Installing dependencies"
npm ci --no-audit --no-fund

echo "==> Generating the Prisma client for this platform"
npx prisma generate

echo "==> Building the deployment bundle"
npm run build:deploy

echo
echo "==> Bundle ready: $ROOT/deploy"
echo "    It contains a Prisma engine for: $(uname -s)/$(uname -m)"
echo
echo "NEXT STEPS"
echo "  1) cp .env.example .env   (then edit the values)"
echo "  2) npx prisma migrate deploy"
echo "  3) bash deploy/start.sh"
echo "  4) copy deploy/.htaccess into the domain's document root (public_html)"
