FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm install
COPY src ./src
COPY tsconfig.json ./
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
RUN apk add --no-cache ffmpeg python3 py3-pip ca-certificates curl \
  && pip install --no-cache-dir --break-system-packages -U "yt-dlp[default]"
RUN pip install --no-cache-dir --break-system-packages --timeout 120 --retries 10 "gallery-dl==1.32.14"
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
RUN addgroup -g 1001 -S nodejs \
  && adduser -S nodejs -u 1001 \
  && mkdir -p /tmp/downloads \
  && chown -R nodejs:nodejs /app /tmp/downloads
USER nodejs
VOLUME ["/tmp/downloads"]
CMD ["node", "dist/index.js"]
