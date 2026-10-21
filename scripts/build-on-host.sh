#!/usr/bin/env bash
# Build the deployment bundle ON THE SERVER.
#
# This is a thin wrapper around scripts/build-on-host.mjs, which does the
# actual work. The Node version exists because a hosting platform's build
# step is far more reliable when it does not depend on a shell: no bash, no
# nvm, no PATH juggling, no .cmd shims. If the platform's build environment
# can run `node`, it can run the build.
#
# Usage (over SSH, from the project directory):
#     bash scripts/build-on-host.sh
#
# On Hostinger, copy the finished bundle straight into the Node.js app root:
#     bash scripts/build-on-host.sh --install-to ~/domains/<domain>/nodejs
#
# Then:
#     npx prisma migrate deploy
#
# The Prisma query engine is a native binary, so it has to be compiled for
# the platform that will RUN the app. A bundle built on Windows contains the
# Windows engine and the app will not start on Linux. Building on the host
# removes that whole class of problem.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# Node is not on the PATH in a plain SSH session on some hosts (Hostinger
# installs it with nvm), so try to load it before giving up.
if ! command -v node >/dev/null 2>&1; then
  # shellcheck disable=SC1091
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"
  if command -v nvm >/dev/null 2>&1; then
    nvm use 22 >/dev/null 2>&1 || nvm use 20 >/dev/null 2>&1 || nvm use >/dev/null 2>&1 || true
  fi
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

exec node scripts/build-on-host.mjs "$@"
