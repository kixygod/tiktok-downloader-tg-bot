#!/bin/sh
set -e

# Проверяем наличие VLESS URL в переменной окружения
if [ -z "$VLESS_URL" ]; then
    echo "Error: VLESS_URL environment variable is required"
    exit 1
fi

# Генерируем конфигурацию v2ray из VLESS URL
echo "Generating v2ray configuration from VLESS URL..."
python3 generate_config.py "$VLESS_URL"

# Запускаем v2ray в фоновом режиме
echo "Starting v2ray..."
v2ray -config /app/v2ray-config.json &
V2RAY_PID=$!

# Чистая остановка по Ctrl-C / docker stop
trap 'kill $V2RAY_PID; wait $V2RAY_PID' INT TERM

# Ждем немного, чтобы v2ray запустился
sleep 2

# Устанавливаем переменные окружения для прокси
export http_proxy=http://127.0.0.1:8080
export https_proxy=http://127.0.0.1:8080
export HTTP_PROXY=http://127.0.0.1:8080
export HTTPS_PROXY=http://127.0.0.1:8080

# Запускаем бота
echo "Starting TikTok bot..."
python bot.py

