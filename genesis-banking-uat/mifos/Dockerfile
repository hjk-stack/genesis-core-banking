# Mifos X web app (openMF/web-app 1.14, pinned by digest) with a same-origin
# reverse proxy to the internal-only Fineract API. Only this container gets
# public ingress; Fineract stays reachable inside the Container Apps
# environment only.
FROM openmf/web-app@sha256:aca1f75e5b66e0000fb26d0b75f3214252591d704c2415e4048868f5e3d3214a

COPY default.conf.template /etc/nginx/genesis/default.conf.template

ENV FINERACT_UPSTREAM=http://genesis-fineract-uat \
    FINERACT_API_PROVIDER=/fineract-provider/api \
    FINERACT_API_VERSION=/v1 \
    FINERACT_PLATFORM_TENANT_IDENTIFIER=default \
    MIFOS_ALLOW_SERVER_SWITCH_SELECTOR=false \
    MIFOS_DISPLAY_TENANT_SELECTOR=false \
    MIFOS_DEFAULT_LANGUAGE=en-US

CMD ["/bin/sh", "-c", "envsubst '${FINERACT_UPSTREAM}' < /etc/nginx/genesis/default.conf.template > /etc/nginx/conf.d/default.conf && envsubst < /usr/share/nginx/html/assets/env.template.js > /usr/share/nginx/html/assets/env.js && exec nginx -g 'daemon off;'"]
