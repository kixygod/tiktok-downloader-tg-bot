FROM node:20-alpine

# ffmpeg + свежий yt-dlp из pip (в apk часто отстаёт; для Instagram это критично)
RUN apk add --no-cache ffmpeg python3 py3-pip ca-certificates make g++ curl \
  && pip install --no-cache-dir --break-system-packages -U "yt-dlp[default]"

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
