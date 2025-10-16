FROM node:20-alpine

# Установка зависимостей для сборки
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

# Оставляем только прод зависимости
RUN npm prune --production

# Создаем пользователя для безопасности
RUN addgroup -g 1001 -S nodejs \
  && adduser -S nodejs -u 1001 \
  && mkdir -p /app/data \
  && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 3000

CMD ["node", "dist/index.js"]
