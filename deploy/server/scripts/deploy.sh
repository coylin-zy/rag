#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

test "$(id -u)" -eq 0 || {
    printf 'Run as root: sudo %s\n' "$0" >&2
    exit 1
}
test -f "$APP_ROOT/web/index.html"
test -f "$APP_ROOT/secrets/rag-proxy-auth.conf"
chmod 0700 "$APP_ROOT/secrets"
chmod 0600 "$APP_ROOT/secrets/rag-proxy-auth.conf"

cd "$APP_ROOT"
docker compose build
docker compose up -d

for attempt in $(seq 1 60); do
    if test "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' rag-frontend 2>/dev/null || true)" = healthy; then
        "$APP_ROOT/scripts/validate.sh"
        printf 'RAG frontend deployment passed all validation checks\n'
        exit 0
    fi
    sleep 1
done

docker compose ps
printf 'RAG frontend container failed its health check\n' >&2
exit 1
