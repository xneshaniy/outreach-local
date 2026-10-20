#!/usr/bin/env bash
# Start the Email Outreach Platform on a shared host (cPanel / StackCP) via SSH.
#
#   ./start.sh          -> start the web app (port 3000) + the worker with pm2
#   ./start.sh stop     -> stop both
#   ./start.sh restart  -> restart both
#   ./start.sh logs     -> tail the logs
#   ./start.sh status   -> show the pm2 status
#
# Requires: Node.js >= 20.9, pm2 (npm i -g pm2), a reachable PostgreSQL.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-3000}"
cd "$APP_DIR"

# Load the environment from .env (if present) for pm2.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

export PORT
export NODE_ENV=production

case "${1:-start}" in
  start)
    echo "==> Starting the web app on port $PORT"
    pm2 start server/server.js --name outreach-app --time --update-env

    echo "==> Starting the background worker"
    pm2 start worker/index.cjs --name outreach-worker --time --update-env

    pm2 save
    pm2 startup systemd -u "$(whoami)" --hp "$HOME" 2>/dev/null || \
      echo "    (run 'pm2 startup' interactively to enable auto-start on reboot)"

    pm2 status
    echo
    echo "Web app: http://127.0.0.1:$PORT"
    echo "Health:  curl http://127.0.0.1:$PORT/api/health"
    ;;

  stop)
    pm2 stop outreach-app outreach-worker || true
    ;;

  restart)
    pm2 restart outreach-app outreach-worker --update-env
    ;;

  logs)
    pm2 logs outreach-app outreach-worker
    ;;

  status)
    pm2 status
    ;;

  *)
    echo "Usage: $0 {start|stop|restart|logs|status}"
    exit 1
    ;;
esac
