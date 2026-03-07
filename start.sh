#!/bin/bash

# Скрипт для быстрого запуска TikTok Bot

set -e

echo "🚀 Запуск TikTok Telegram Bot..."

# Проверяем наличие .env файла
if [ ! -f .env ]; then
    echo "❌ Файл .env не найден!"
    echo "📋 Скопируйте env.example в .env и заполните переменные:"
    echo "   cp env.example .env"
    echo "   nano .env"
    exit 1
fi

# Проверяем наличие BOT_TOKEN
if ! grep -q "BOT_TOKEN=" .env || grep -q "BOT_TOKEN=1234567890" .env; then
    echo "❌ BOT_TOKEN не настроен в .env файле!"
    echo "📋 Получите токен у @BotFather и добавьте в .env"
    exit 1
fi

# Подтягиваем переменные из .env
set -a
source .env
set +a

# Определяем, нужно ли поднимать Xray
XRAY_ENABLED="${USE_XRAY:-true}"

if [ "$XRAY_ENABLED" = "false" ] || [ "$XRAY_ENABLED" = "0" ]; then
    echo "⚙️ USE_XRAY=$XRAY_ENABLED → Xray будет ОТКЛЮЧЕН, работаем напрямую без прокси"

    # Глушим все переменные прокси, чтобы внутри контейнеров трафик шёл напрямую
    export XRAY_HTTP_PROXY=
    export XRAY_HTTPS_PROXY=
    export XRAY_ALL_PROXY=
    export YTDLP_PROXY_HYSTERIA2=
    export YTDLP_PROXY_VLESS=
    export YTDLP_PROXY_SHADOWSOCKS=

    USE_XRAY_FLAG=false
else
    echo "⚙️ USE_XRAY=$XRAY_ENABLED → Xray ВКЛЮЧЕН, трафик пойдёт через прокси"
    USE_XRAY_FLAG=true

    # Проверяем настройки VLESS только если Xray включён
    if grep -q "VLESS_SERVER_HOST" xray/config.json; then
        echo "❌ VLESS настройки не заполнены в xray/config.json!"
        echo "📋 Отредактируйте xray/config.json с вашими VLESS данными"
        exit 1
    fi
fi

echo "✅ Проверки пройдены, запускаем сервисы..."

# Определяем, какая команда docker compose доступна (V1 или V2)
if command -v docker-compose &> /dev/null; then
    DOCKER_COMPOSE_CMD="docker-compose"
elif docker compose version &> /dev/null; then
    DOCKER_COMPOSE_CMD="docker compose"
else
    echo "❌ Docker Compose не найден! Установите docker-compose или обновите Docker до версии с встроенным compose."
    exit 1
fi

echo "🔧 Используется команда: $DOCKER_COMPOSE_CMD"

# Останавливаем если уже запущены
$DOCKER_COMPOSE_CMD down 2>/dev/null || true

if [ "$USE_XRAY_FLAG" = "true" ]; then
    # Собираем и запускаем все сервисы, включая Xray (профиль xray)
    $DOCKER_COMPOSE_CMD --profile xray up -d --build
else
    # Собираем и запускаем только postgres + redis + bot + worker (без Xray)
    $DOCKER_COMPOSE_CMD up -d --build postgres redis bot worker
fi

echo "⏳ Ожидаем запуска сервисов..."
sleep 10

# Проверяем статус
echo "📊 Статус сервисов:"
$DOCKER_COMPOSE_CMD ps

echo ""
echo "🎉 Бот запущен!"
echo ""
echo "📱 Добавьте бота в чат и отправьте ссылку на TikTok"
echo "📊 Дашборд: http://localhost:3000/dashboard"
echo "📋 Логи: $DOCKER_COMPOSE_CMD logs -f"
echo "🛑 Остановка: $DOCKER_COMPOSE_CMD down"

