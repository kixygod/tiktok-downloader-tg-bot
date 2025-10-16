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

# Проверяем настройки VLESS
if grep -q "VLESS_SERVER_HOST" xray/config.json; then
    echo "❌ VLESS настройки не заполнены в xray/config.json!"
    echo "📋 Отредактируйте xray/config.json с вашими VLESS данными"
    exit 1
fi

echo "✅ Проверки пройдены, запускаем сервисы..."

# Останавливаем если уже запущены
docker compose down 2>/dev/null || true

# Собираем и запускаем
docker compose up -d --build

echo "⏳ Ожидаем запуска сервисов..."
sleep 10

# Проверяем статус
echo "📊 Статус сервисов:"
docker compose ps

echo ""
echo "🎉 Бот запущен!"
echo ""
echo "📱 Добавьте бота в чат и отправьте ссылку на TikTok"
echo "📊 Дашборд: http://localhost:3000/dashboard"
echo "📋 Логи: docker compose logs -f"
echo "🛑 Остановка: docker compose down"
