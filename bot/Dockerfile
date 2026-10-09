FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm install
COPY src ./src
COPY tsconfig.json ./
COPY dashboard.html ./
COPY assets ./assets
RUN npm run build \
  && mkdir -p vendor \
  && cp node_modules/chart.js/dist/chart.umd.js vendor/chart.umd.js \
  && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/vendor ./vendor
COPY dashboard.html ./
COPY assets ./assets
COPY package.json ./
RUN addgroup -g 1001 -S nodejs \
  && adduser -S nodejs -u 1001 \
  && chown -R nodejs:nodejs /app
USER nodejs
EXPOSE 3000
CMD ["node", "dist/index.js"]
