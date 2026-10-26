FROM node:20-bookworm-slim

# Build tools are only a fallback in case a prebuilt better-sqlite3 binary isn't available
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data
RUN mkdir -p /data
# Runs as root on purpose: platform volumes (Render disk, Fly volume) mount root-owned.

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
