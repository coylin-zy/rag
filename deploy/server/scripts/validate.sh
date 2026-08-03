#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DOMAIN="${1:-rag.coylin.com}"

test "$(id -u)" -eq 0
for required in curl docker nginx openssl sha256sum; do
    command -v "$required" >/dev/null 2>&1
done

cd "$APP_ROOT"
sha256sum -c MANIFEST.sha256
test "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' rag-frontend)" = healthy

ASSET_PATHS="$(grep -oE '/assets/[A-Za-z0-9_.-]+\.(js|css)' "$APP_ROOT/web/index.html" | sort -u)"
test -n "$ASSET_PATHS"

docker compose ps
curl -fsS -o /dev/null -w 'container_frontend=%{http_code}\n' http://127.0.0.1:3020/

asset_count=0
for asset in $ASSET_PATHS; do
    test -f "$APP_ROOT/web$asset"

    container_result="$(curl -sS -o /dev/null -w '%{http_code} %{content_type}' "http://127.0.0.1:3020$asset")"
    host_result="$(curl -sS --resolve "$DOMAIN:443:127.0.0.1" -o /dev/null -w '%{http_code} %{content_type}' "https://$DOMAIN$asset")"
    test "${container_result%% *}" = 200
    test "${host_result%% *}" = 200

    case "$asset" in
        *.js)
            case "${container_result#* } ${host_result#* }" in
                *javascript*javascript*) ;;
                *) printf 'Unexpected JavaScript Content-Type for %s\n' "$asset" >&2; exit 1 ;;
            esac
            ;;
        *.css)
            case "${container_result#* } ${host_result#* }" in
                *text/css*text/css*) ;;
                *) printf 'Unexpected CSS Content-Type for %s\n' "$asset" >&2; exit 1 ;;
            esac
            ;;
    esac

    asset_count=$((asset_count + 1))
    printf 'asset=%s container=200 host=200\n' "$asset"
done

test "$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:3020/api/v1/session)" = 401
printf 'container_worker_session=401\n'
nginx -t
curl -fsS --resolve "$DOMAIN:443:127.0.0.1" -o /dev/null -w "$DOMAIN=%{http_code}\n" "https://$DOMAIN/"
test "$(curl -sS --resolve "$DOMAIN:443:127.0.0.1" -o /dev/null -w '%{http_code}' "https://$DOMAIN/api/v1/session")" = 401
printf 'host_worker_session=401\n'
printf 'verified_assets=%s\n' "$asset_count"
openssl x509 -in "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" -noout -subject -dates -ext subjectAltName
