#!/usr/bin/env bash
# Build the deployment bundle ON THE SERVER.
#
# The Prisma query engine is a native binary, so it has to be compiled for the
# platform that will RUN the app. A bundle built on Windows contains the
# Windows engine and crashes the moment it is started on Linux. Building on the
# host removes that whole class of problem.
#
# Works on Hostinger, cPanel / StackCP, or any Linux box with Node >= 20.9.
#
# Usage (over SSH, from the project directory):
#     bash scripts/build-on-host.sh
#
# On Hostinger, copy the finished bundle straight into the Node.js app root:
#     bash scripts/build-on-host.sh --install-to ~/domains/<domain>/nodejs
#
# Then:
#     npx prisma migrate deploy
#     bash deploy/start.sh          # or point the hPanel Node app at it
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
ROOT="$(pwd)"

INSTALL_TO=""
SKIP_INSTALL="false"
while [ $# -gt 0 ]; do
  case "$1" in
    --install-to)
      INSTALL_TO="${2:-}"
      shift 2
      ;;
    --skip-install)
      # The hosting platform already ran `npm install` as its own build step.
      SKIP_INSTALL="true"
      shift
      ;;
    -h | --help)
      sed -n '2,22p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# 1. Make sure Node is on the PATH.
#
#    Hostinger installs Node with nvm, which is NOT on the PATH in a plain SSH
#    session. Without this, "node: command not found" is the first thing you
#    see. We load nvm and select the newest installed 22.x/20.x runtime.
# ---------------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "==> Node is not on the PATH — looking for an nvm installation"
  # shellcheck disable=SC1091
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

  if command -v nvm >/dev/null 2>&1; then
    nvm use 22 >/dev/null 2>&1 || nvm use 20 >/dev/null 2>&1 || nvm use >/dev/null 2>&1 || true
  fi

  # Fall back to the newest version nvm has on disk.
  if ! command -v node >/dev/null 2>&1 && [ -d "$HOME/.nvm/versions/node" ]; then
    for candidate in $(ls -1 "$HOME/.nvm/versions/node" 2>/dev/null | sort -V | tac); do
      export PATH="$HOME/.nvm/versions/node/$candidate/bin:$PATH"
      break
    done
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  cat >&2 <<'EOF'

ERROR: Node.js was not found on this server.

On Hostinger, install it from hPanel:
  Websites -> your domain -> "Setup Node.js App" -> choose version 22.x.
That also makes Node available over SSH (under ~/.nvm/versions/node/).

Then re-run:
  source ~/.nvm/nvm.sh && nvm use 22
  bash scripts/build-on-host.sh

EOF
  exit 1
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: Node $(node -v) is too old. This application needs Node >= 20.9." >&2
  exit 1
fi

echo "==> Node $(node -v), npm $(npm -v)"
echo "==> Platform: $(uname -s)/$(uname -m)"

# ---------------------------------------------------------------------------
# 2. Dependencies, Prisma client, bundle.
# ---------------------------------------------------------------------------
echo
echo "==> Installing dependencies"
if [ "$SKIP_INSTALL" = "true" ]; then
  echo "    (skipped - the platform already installed them)"
elif [ -f package-lock.json ]; then
  # --include=dev matters: hosting platforms set NODE_ENV=production, and npm
  # then omits devDependencies - which is where the Prisma CLI and esbuild
  # live. Without them the build cannot run.
  npm ci --include=dev --no-audit --no-fund
else
  npm install --include=dev --no-audit --no-fund
fi

echo
echo "==> Generating the Prisma client for this platform"
npx prisma generate

echo
echo "==> Building the deployment bundle"
npm run build:deploy

# ---------------------------------------------------------------------------
# 3. Optionally copy the bundle into the hosting app root.
# ---------------------------------------------------------------------------
if [ -n "$INSTALL_TO" ]; then
  TARGET="$(mkdir -p "$INSTALL_TO" && cd "$INSTALL_TO" && pwd)"
  echo
  echo "==> Installing the bundle into $TARGET"
  # rsync keeps the copy incremental; fall back to cp when rsync is missing.
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete "$ROOT/deploy/" "$TARGET/"
  else
    rm -rf "${TARGET:?}/server" "${TARGET:?}/worker" "${TARGET:?}/node_modules" "${TARGET:?}/prisma"
    cp -r "$ROOT/deploy/." "$TARGET/"
  fi
  echo "    done. The application root in hPanel should be:"
  echo "      $TARGET"
fi

echo
echo "==> Bundle ready: $ROOT/deploy"
echo "    Prisma engine for: $(uname -s)/$(uname -m)"
echo
echo "NEXT STEPS"
echo "  1) Apply the database migrations (needs DATABASE_URL set):"
echo "       npx prisma migrate deploy"
echo "  2) Start the app and the worker:"
echo "       npm install -g pm2     # if pm2 is missing"
echo "       bash deploy/start.sh"
echo "  3) Point the domain at the app."
echo "     Hostinger: hPanel -> Websites -> <domain> -> Setup Node.js App"
echo "       Application root : nodejs"
echo "       Application URL  : server/server.js"
echo "       Node version      : 22.x"
echo "     Other hosts: copy deploy/.htaccess into the document root."
echo
echo "  Full instructions: docs/HOSTINGER.md"
