# fileshare — all-in-one image (Node.js + app, data in /data volume)
FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    UPLOAD_DIR=/data/uploads \
    DATA_FILE=/data/files.json \
    KEYS_FILE=/data/keys.json \
    KEY_FILE=""
# Keys are printed to the container logs on startup (docker logs ...).
# Set ADMIN_KEY and/or UPLOAD_KEY as env vars to keep them stable across
# container restarts; otherwise new random keys are generated each start.

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js ./
COPY config.json ./
COPY public ./public
# To use your own config.json without rebuilding:
#   docker run ... -v /path/to/config.json:/app/config.json:ro ...

# Data dir lives on a volume; the container runs as the unprivileged node user.
RUN mkdir -p /data/uploads && chown -R node:node /data
USER node

VOLUME ["/data"]
EXPOSE 3000

CMD ["node", "server.js"]
