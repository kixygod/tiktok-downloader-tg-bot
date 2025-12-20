# TikTok Telegram Bot

Быстрый и эффективный Telegram бот для скачивания видео с поддержкой Hysteria2 VPN, веб-дашбордом статистики и умным сжатием видео.

## 🚀 Особенности

- **Асинхронная обработка** через Redis очередь (BullMQ)
- **Hysteria2 VPN поддержка** - весь трафик только через VPN (sing-box)
- **Умное сжатие** - автоматическое сжатие видео под лимит 50MB
- **Веб-дашборд** - статистика за день/неделю/месяц/всё время с графиками
- **Высокая производительность** - TypeScript + Node.js 20
- **Безопасность** - все файлы временные, автоматическая очистка
- **Масштабируемость** - легко добавить больше воркеров
- **Умные уведомления** - показывает среднее время ожидания
- **Мультиплатформенность** - поддержка TikTok, YouTube Shorts, VK Clips

## 📋 Требования

- Docker и Docker Compose
- Hysteria2 сервер с доступом в интернет
- Telegram Bot Token (получить у @BotFather)

## 🛠 Быстрая установка

### 1. Клонирование и настройка

```bash
git clone <your-repo>
cd tiktok-tg-bot

# Скопируйте переменные окружения
cp env.example .env
```

### 2. Настройка переменных окружения

Отредактируйте `.env`:

```env
BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
DASHBOARD_BASIC_AUTH=admin:your_secure_password
```

### 3. Настройка Hysteria2

**⚠️ ВАЖНО**: Файл `xray/config.json` содержит ваши приватные ключи и НЕ должен попадать в Git!

1. **Скопируйте пример конфигурации**:
   ```bash
   cp xray/config.example.json xray/config.json
   ```

2. **Отредактируйте `xray/config.json`** с вашими данными Hysteria2:

```json
{
  "log": {
    "level": "warn"
  },
  "inbounds": [
    {
      "type": "socks",
      "tag": "socks-in",
      "listen": "0.0.0.0",
      "listen_port": 1080,
      "sniff": true,
      "sniff_override_destination": false
    },
    {
      "type": "http",
      "tag": "http-in",
      "listen": "0.0.0.0",
      "listen_port": 1087,
      "sniff": true,
      "sniff_override_destination": false
    }
  ],
  "outbounds": [
    {
      "type": "hysteria2",
      "tag": "hysteria2-out",
      "server": "YOUR_SERVER_IP",
      "server_port": 443,
      "password": "YOUR_PASSWORD",
      "tls": {
        "enabled": true,
        "server_name": "YOUR_SNI",
        "insecure": false
      },
      "obfs": {
        "type": "salamander",
        "password": "YOUR_OBFS_PASSWORD"
      }
    },
    {
      "type": "direct",
      "tag": "direct"
    }
  ],
  "route": {
    "rules": [
      {
        "network": "tcp,udp",
        "outbound": "hysteria2-out"
      }
    ],
    "final": "hysteria2-out"
  },
  "dns": {
    "servers": [
      {
        "tag": "google",
        "address": "https://8.8.8.8/dns-query",
        "detour": "direct"
      },
      {
        "tag": "cloudflare",
        "address": "https://1.1.1.1/dns-query",
        "detour": "direct"
      }
    ],
    "strategy": "prefer_ipv4"
  }
}
```

**Параметры для замены:**
- `YOUR_SERVER_IP` - IP адрес вашего Hysteria2 сервера
- `YOUR_PASSWORD` - пароль из Hysteria2 конфигурации
- `YOUR_SNI` - Server Name Indication (обычно домен сервера)
- `YOUR_OBFS_PASSWORD` - пароль для обфускации (salamander)

### 4. Запуск

```bash
# Простой запуск
docker compose up -d --build

# Проверка статуса
docker compose ps
```

### 5. Проверка работы

- **Бот**: Добавьте в чат и отправьте TikTok ссылку
- **Дашборд**: http://localhost:3000/dashboard (логин: admin, пароль: из .env)
- **Логи**: `docker compose logs -f`

## 📱 Использование

1. **Добавьте бота** в чат/группу
2. **Отправьте ссылку** на видео
3. **Бот ответит** реплаем с видео (если ≤50MB) или сообщением об ошибке

### Поддерживаемые платформы:

**TikTok:**
- `https://www.tiktok.com/@user/video/1234567890`
- `https://vm.tiktok.com/ABC123/`
- `https://vt.tiktok.com/XYZ789/`

**YouTube Shorts:**
- `https://www.youtube.com/shorts/VIDEO_ID`

**VK Clips:**
- `https://vk.com/clip-123456789_987654321`

**Примеры ответов бота:**
```
Обрабатываю ссылку…
Среднее время ожидания: 15с 😉
```

## 📊 Веб-дашборд

Доступен по адресу: http://localhost:53500/dashboard

### Возможности:
- **Статистика**: за 24ч, 7д, 30д, всё время
- **Графики активности**: по часам и дням
- **Производительность**: время обработки
- **Авто-обновление**: каждые 3 секунды
- **Адаптивный дизайн**: темная/светлая тема

### Метрики:
- `jobs_total` - общее количество задач
- `jobs_success` - успешно обработанные
- `jobs_compressed` - сжатые видео
- `jobs_too_large` - превышение лимита
- `jobs_failed` - ошибки
- `avg_duration_ms` - средняя длительность
- `traffic_mb` - суммарный трафик

## 🛡 Безопасность

- **Конфиденциальные данные**: `xray/config.json` и `.env` файлы исключены из Git
- **Временные файлы**: все скачанные файлы автоматически удаляются
- **VPN трафик**: весь исходящий трафик только через Hysteria2 VPN (sing-box)
- **Аутентификация**: базовая аутентификация для дашборда
- **Изоляция**: контейнеры изолированы через Docker сети
- **Лимиты**: строгий лимит 50MB на файлы

## 🔄 Обновление

```bash
# Остановка
docker compose down

# Обновление кода
git pull

# Пересборка и запуск
docker compose up -d --build
```

## 📈 Мониторинг

### Логи
```bash
# Все сервисы
docker compose logs -f

# Конкретный сервис
docker compose logs bot
docker compose logs worker
docker compose logs redis
docker compose logs xray
```

### Статус
```bash
# Статус сервисов
docker compose ps

# Использование ресурсов
docker stats

# Проверка здоровья
curl http://localhost:53500/health
```

## 🆘 Решение проблем

### Бот не отвечает
1. Проверьте `BOT_TOKEN` в `.env`
2. Убедитесь что бот запущен: `docker compose logs bot`
3. Проверьте настройки бота в @BotFather:
   ```
   /setprivacy - Disable (чтобы видеть все сообщения)
   /setjoingroups - Enable (для работы в группах)
   ```

### Ошибки скачивания
1. Проверьте настройки Hysteria2 в `xray/config.json`
2. Убедитесь что VPN сервер работает
3. Проверьте логи воркера: `docker compose logs worker`
4. Проверьте логи прокси: `docker compose logs xray`

### Дашборд недоступен
1. Проверьте что порт 3000 открыт
2. Проверьте `DASHBOARD_BASIC_AUTH` в `.env`
3. Проверьте логи бота: `docker compose logs bot`

### Файлы слишком большие
1. Бот автоматически сжимает видео под 50MB
2. Если не получается - отправляет сообщение об ошибке
3. Настройте `SIZE_LIMIT_MB` в `.env` (по умолчанию 50)

## 🔒 Git безопасность

### Инициализация репозитория
```bash
git init
git add .
git commit -m "Initial commit: TikTok Bot with Hysteria2 VPN"
git remote add origin <your-github-repo-url>
git push -u origin main
```

### Что защищено .gitignore
- `xray/config.json` - ваши Hysteria2 ключи и пароли
- `.env` - токены бота и пароли
- `bot_data/` - база данных SQLite
- `tmp_data/` - временные файлы
- `backup/` - резервные копии
- `node_modules/` - зависимости Node.js
- `dist/` - скомпилированные файлы

### ⚠️ Важно
1. **НИКОГДА не коммитьте** файлы с реальными ключами
2. **Всегда проверяйте** `git status` перед коммитом
3. **Используйте** `xray/config.example.json` как шаблон

## 🏗 Архитектура

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   Telegram  │───▶│     Bot     │───▶│    Redis    │
│     API     │    │  (grammY)   │    │   (Queue)   │
└─────────────┘    └─────────────┘    └─────────────┘
                           │                   │
                           ▼                   ▼
                   ┌─────────────┐    ┌─────────────┐
                   │   Fastify   │    │   Worker    │
                   │ (Dashboard) │    │ (yt-dlp)    │
                   └─────────────┘    └─────────────┘
                                            │
                                            ▼
                                   ┌─────────────┐
                                   │  sing-box   │
                                   │ (Hysteria2) │
                                   └─────────────┘
```

### Компоненты:
- **Bot** (`bot/`) - Telegram бот и веб-дашборд
- **Worker** (`worker/`) - обработка видео ссылок (yt-dlp)
- **Redis** - очередь задач (BullMQ)
- **sing-box** - Hysteria2 клиент для VPN (контейнер xray)
- **SQLite** - статистика (встроена в бот)

## ⚙️ Настройки

### Переменные окружения (.env)
```env
BOT_TOKEN=your_telegram_bot_token
DASHBOARD_BASIC_AUTH=admin:password
SIZE_LIMIT_MB=50
MAX_CONCURRENCY=2
```

**Примечание**: Прокси настраивается автоматически через переменные окружения в `docker-compose.yml`:
- `HTTP_PROXY=http://xray:1087` - HTTP прокси для yt-dlp
- `HTTPS_PROXY=http://xray:1087` - HTTPS прокси
- `ALL_PROXY=socks5h://xray:1080` - SOCKS5 прокси (fallback)

### Docker Compose
- **Redis**: очередь задач без персистентности
- **xray** (sing-box): Hysteria2 клиент с HTTP (1087) и SOCKS5 (1080) прокси
- **Bot**: основной сервис с дашбордом (порт 53500)
- **Worker**: обработка видео через VPN (yt-dlp, ffmpeg)

## 📄 Лицензия

MIT License - используйте свободно для любых целей.

---

**При возникновении проблем:**
1. Проверьте логи всех сервисов
2. Убедитесь в правильности настроек Hysteria2 в `xray/config.json`
3. Проверьте доступность Telegram API через VPN
4. Убедитесь что прокси работает: `docker compose logs xray`
