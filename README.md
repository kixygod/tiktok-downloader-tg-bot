
# TikTok Auto-Downloader · Telegram Bot

Отправляйте боту ссылку — он забирает ролик **или** фотокарусель из TikTok (без ватермарки, HQ) и кидает файлы в ответ.

---

## Быстрый запуск

```bash
git clone https://github.com/kixygod/tiktok-downloader-tg-bot.git
cd tiktok-downloader-tg-bot

# заполните токен в .env
cp .env.example .env   # редактируем TELEGRAM_TOKEN

# (опционально) если нужен обход блокировок:
# cp my-wg.conf vpn.conf   # ваш WireGuard-конфиг

docker compose up --build -d
docker compose logs -f     # смотреть логи
```

---

## Файл `.env`

| переменная       | значение                           |
| ---------------- | ---------------------------------- |
| `TELEGRAM_TOKEN` | токен вашего Telegram-бота         |
| `TZ` *(опц.)*    | тайм-зона контейнера, дефолт `UTC` |

```dotenv
TELEGRAM_TOKEN=80******40:xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TZ=Europe/Moscow
```

---

## Интернет в РФ

TikTok-домены могут быть недоступны.
Скопируйте рабочий **WireGuard**-конфиг в корень проекта под именем `vpn.conf` — скрипт `start.sh` поднимет интерфейс `vpn` внутри контейнера перед запуском бота.

---

## Структура

```
bot.py                – логика Telegram, media-groups, typing-status
downloader.py         – 6 API + yt-dlp, видео и фото
Dockerfile
docker-compose.yml    – монтирует .env и vpn.conf
start.sh              – опц. WireGuard + запуск бота
```

---

## Полезные команды

```bash
docker compose exec bot bash   # зайти в контейнер
docker compose restart bot     # перезапуск
docker compose down            # остановить и удалить
```
