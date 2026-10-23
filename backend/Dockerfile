# Node.js 22 LTS (Active LTS) on Alpine Linux
# Required for better-sqlite3 v13.x native addon engine compatibility (Node >=22)
FROM node:22-alpine

# Install Docker CLI and C++ runtime library for native modules
RUN apk add --no-cache docker-cli libstdc++

WORKDIR /app

# Copy dependency manifests
COPY package*.json ./

# Deterministic production dependency installation with temporary build dependencies
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
    && npm ci --omit=dev \
    && apk del .build-deps \
    && rm -rf /root/.npm

# Copy application source (respecting backend/.dockerignore)
COPY . .

# Ensure data directory exists for runtime mounts
RUN mkdir -p /app/data

EXPOSE 5001

CMD ["node", "server.js"]
