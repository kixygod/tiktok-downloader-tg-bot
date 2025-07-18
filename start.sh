#!/bin/sh
set -e

# Поднимаем WG-интерфейс
wg-quick up /app/vpn.conf

# Чистая остановка по Ctrl-C / docker stop
trap 'wg-quick down /app/vpn.conf' INT TERM

# Запускаем бота
python bot.py

