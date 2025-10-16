FROM node:20-alpine

# Установка yt-dlp и ffmpeg
RUN apk add --no-cache yt-dlp ffmpeg python3 make g++ curl

WORKDIR /app

# Копируем package.json и устанавливаем зависимости (без lockfile используем install)
COPY package*.json ./
RUN npm install

# Копируем исходный код и tsconfig
COPY src ./src
COPY tsconfig.json ./

# Компилируем TypeScript
RUN npm run build

# Оставляем только прод зависимости
RUN npm prune --production

# Создаем пользователя для безопасности и директории
RUN addgroup -g 1001 -S nodejs \
  && adduser -S nodejs -u 1001 \
  && mkdir -p /tmp/downloads \
  && chown -R nodejs:nodejs /app /tmp/downloads

USER nodejs

VOLUME ["/tmp/downloads"]

CMD ["node", "dist/index.js"]
