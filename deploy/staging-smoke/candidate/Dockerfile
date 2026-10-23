# ==============================================================================
# K-PANEL DISPOSABLE STAGING CANDIDATE (ARM64 / Multi-Arch Compatible)
# Non-root user, stateless, read-only rootfs compatible, explicit HEALTHCHECK.
# ==============================================================================

FROM node:20-alpine

# Set non-root execution directory
WORKDIR /home/node/app

# Copy pure built-in HTTP server (zero npm dependencies)
COPY --chown=node:node server.js .

# Enforce unprivileged execution (UID 1000: node)
USER node

# Fixed internal application port (8080 across candidate, ingress, healthcheck, and Compose)
ENV PORT=8080 \
    NODE_ENV=production

EXPOSE 8080

# Explicit container healthcheck using built-in wget on fixed port 8080
HEALTHCHECK --interval=5s --timeout=3s --start-period=2s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "server.js"]
