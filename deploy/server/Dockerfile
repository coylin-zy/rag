FROM nginx:1.27-alpine

COPY nginx/container.conf /etc/nginx/conf.d/default.conf
COPY nginx/rag-api-proxy-common.conf /etc/nginx/snippets/rag-api-proxy-common.conf
COPY web/ /usr/share/nginx/html/

RUN set -eu; \
    chmod -R a+rX /usr/share/nginx/html; \
    test -f /usr/share/nginx/html/index.html; \
    assets="$(grep -oE '/assets/[A-Za-z0-9_.-]+\.(js|css)' /usr/share/nginx/html/index.html | sort -u)"; \
    test -n "$assets"; \
    for asset in $assets; do test -r "/usr/share/nginx/html$asset"; done

EXPOSE 8080
