# ==============================================================================
# K-PANEL DISPOSABLE STAGING INGRESS DOCKERFILE (UNPRIVILEGED NGINX)
# Multi-arch / ARM64 compatible, non-root, read-only rootfs compatible.
# ==============================================================================

FROM nginxinc/nginx-unprivileged:alpine

# Copy minimal, hardened, stateless staging ingress configuration
COPY --chown=101:101 nginx.conf /etc/nginx/nginx.conf

# Healthcheck testing loopback response
HEALTHCHECK --interval=5s --timeout=3s --start-period=2s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

EXPOSE 8080

CMD ["nginx", "-g", "daemon off;"]
