#!/bin/sh
set -e

# Проверяем наличие VLESS URL в переменной окружения
if [ -z "$VLESS_URL" ]; then
    echo "Error: VLESS_URL environment variable is required"
    exit 1
fi

# Функция для проверки соединения
check_connection() {
    echo "Checking connection..."
    if curl -s --proxy http://127.0.0.1:8080 --connect-timeout 10 https://www.tiktok.com > /dev/null; then
        echo "✅ Connection OK"
        return 0
    else
        echo "❌ Connection failed"
        return 1
    fi
}

# Функция для перезапуска xray
restart_xray() {
    echo "Restarting xray..."
    if [ ! -z "$V2RAY_PID" ]; then
        kill $V2RAY_PID 2>/dev/null || true
        wait $V2RAY_PID 2>/dev/null || true
    fi

    # Ждем немного перед перезапуском
    sleep 2

    # Генерируем новую конфигурацию
    echo "Regenerating xray configuration..."
    python3 generate_config.py "$VLESS_URL"

    # Запускаем xray заново
    echo "Starting xray..."
    xray run -config /app/v2ray-config.json &
    V2RAY_PID=$!

    # Ждем запуска
    sleep 3
}

# Генерируем конфигурацию xray из VLESS URL
echo "Generating xray configuration from VLESS URL..."
python3 generate_config.py "$VLESS_URL"

# Запускаем xray в фоновом режиме
echo "Starting xray..."
xray run -config /app/v2ray-config.json &
V2RAY_PID=$!

# Чистая остановка по Ctrl-C / docker stop
trap 'kill $V2RAY_PID; wait $V2RAY_PID' INT TERM

# Ждем немного, чтобы v2ray запустился
sleep 3

# Проверяем соединение
if ! check_connection; then
    echo "Initial connection failed, retrying..."
    restart_xray
    sleep 5

    if ! check_connection; then
        echo "❌ Failed to establish connection after retry"
        exit 1
    fi
fi

# Устанавливаем переменные окружения для прокси
export http_proxy=http://127.0.0.1:8080
export https_proxy=http://127.0.0.1:8080
export HTTP_PROXY=http://127.0.0.1:8080
export HTTPS_PROXY=http://127.0.0.1:8080

echo "✅ Proxy configured successfully"

# Запускаем мониторинг соединения в фоновом режиме
monitor_connection() {
    while true; do
        sleep 3600  # Проверяем каждый час

        if ! check_connection; then
            echo "⚠️ Connection lost, attempting to restore..."
            restart_xray

            sleep 10
            if check_connection; then
                echo "✅ Connection restored"
            else
                echo "❌ Failed to restore connection"
            fi
        else
            echo "✅ Connection check passed"
        fi
    done
}

# Запускаем мониторинг в фоновом режиме
monitor_connection &
MONITOR_PID=$!

# Очистка при выходе
trap 'kill $V2RAY_PID $MONITOR_PID; wait $V2RAY_PID $MONITOR_PID' INT TERM

# Запускаем бота
echo "Starting TikTok bot..."
python bot.py

