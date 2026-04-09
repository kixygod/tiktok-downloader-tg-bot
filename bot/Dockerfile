FROM node:20-alpine

# python3/make/g++ needed for native addons
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Копируем package.json и устанавливаем зависимости (без lockfile используем install)
COPY package*.json ./
RUN npm install

# Копируем исходный код и tsconfig
COPY src ./src
COPY tsconfig.json ./
COPY dashboard.html ./

# Компилируем TypeScript
RUN npm run build

# Самохостинг Chart.js (HTTP + публичный IP: CDN режут Private Network Access в Chrome)
RUN mkdir -p vendor && cp node_modules/chart.js/dist/chart.umd.js vendor/chart.umd.js

# Оставляем только прод зависимости
RUN npm prune --production

# Создаем пользователя для безопасности
RUN addgroup -g 1001 -S nodejs \
  && adduser -S nodejs -u 1001 \
  && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3000

CMD ["node", "dist/index.js"]
