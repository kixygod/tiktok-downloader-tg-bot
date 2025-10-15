

# TikTok Auto-Downloader · Telegram Bot

Отправляйте боту ссылку — он забирает ролик **или** фотокарусель из TikTok (без ватермарки, HQ) и кидает файлы в ответ.

---

## Создание бота

1. Откройте Telegram и найдите `@BotFather`.
2. Отправьте команду `/start`, затем `/newbot`.
3. Следуйте инструкциям: задайте имя и username бота (должен заканчиваться на `Bot` или `Bot`).
4. После создания BotFather выдаст вам `TELEGRAM_TOKEN`. Сохраните его.
5. Добавьте бота в группу, где планируете скачивать TikTok-контент, или используйте его в личных сообщениях.

---

## Быстрый запуск

```bash
git clone https://github.com/kixygod/tiktok-downloader-tg-bot.git
cd tiktok-downloader-tg-bot

# заполните токен и VLESS URL в .env
cp .env.example .env   # редактируем TELEGRAM_TOKEN и VLESS_URL

docker compose up --build -d
docker compose logs -f     # смотреть логи
```

---

## Файл `.env`

| переменная       | значение                           |
| ---------------- | ---------------------------------- |
| `TELEGRAM_TOKEN` | токен вашего Telegram-бота         |
| `VLESS_URL`      | VLESS URL для VPN подключения      |
| `TZ` *(опц.)*    | тайм-зона контейнера, дефолт `UTC` |

```dotenv
TELEGRAM_TOKEN=80******40:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
VLESS_URL=vless://********-****-****-****-*********************************************************************
TZ=Europe/Moscow
```

---

## Интернет в РФ

TikTok-домены могут быть недоступны.
Используйте VLESS прокси для обхода блокировок. Укажите ваш VLESS URL в переменной окружения `VLESS_URL` в файле `.env`.

---

## Структура

```
bot.py                – логика Telegram, media-groups, typing-status
downloader.py         – 6 API + yt-dlp, видео и фото
Dockerfile            – установка v2ray-core и Python зависимостей
docker-compose.yml    – монтирует .env и переменные окружения
start.sh              – запуск v2ray + запуск бота
generate_config.py    – генерация конфигурации v2ray из VLESS URL
```

---

## Полезные команды

```bash
docker compose exec tiktok-bot bash   # зайти в контейнер
docker compose restart tiktok-bot     # перезапуск
docker compose down                   # остановить и удалить
```
