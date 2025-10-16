import os, re, logging, tempfile, asyncio, io, time
from downloader import fetch
from connection_monitor import start_connection_monitor, get_connection_status
from telegram import Update, InputMediaPhoto
from telegram.constants import ChatAction
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    ContextTypes,
    filters,
)
from telegram.error import NetworkError, TimedOut

TOKEN = os.getenv("TELEGRAM_TOKEN")
if not TOKEN:
    raise ValueError("TELEGRAM_TOKEN environment variable is not set!")

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s - %(name)s - %(levelname)s - %(message)s"
)
log = logging.getLogger("ttbot")
tiktok_re = re.compile(r"https?://(?:[a-z]+\.)?tiktok\.com/[^\s]+")


async def cmd_start(update: Update, _):
    log.info(f"Received /start command from user {update.effective_user.id}")
    await update.effective_message.reply_text(
        "Присылай ссылки на TikTok – скачаю видео/картинки."
    )


async def cmd_help(update: Update, _):
    log.info(f"Received /help command from user {update.effective_user.id}")
    await update.effective_message.reply_text(
        "🤖 TikTok Downloader Bot\n\n"
        "Просто отправь ссылку на TikTok видео или пост с картинками, и я скачаю их для тебя!\n\n"
        "Поддерживаемые форматы:\n"
        "• Видео (MP4)\n"
        "• Фотографии (JPG)\n\n"
        "Команды:\n"
        "/start - Начать работу\n"
        "/help - Показать эту справку\n"
        "/status - Проверить статус соединения"
    )


async def cmd_status(update: Update, _):
    """Команда для проверки статуса соединения"""
    log.info(f"Received /status command from user {update.effective_user.id}")

    status = get_connection_status()

    if status["is_connected"]:
        status_text = "✅ Соединение активно"
    else:
        status_text = "❌ Проблемы с соединением"

    message = f"""🔍 Статус соединения:

{status_text}

📊 Детали:
• Прокси: {status['proxy_url']}
• Неудачных проверок: {status['failed_checks']}
• Последняя проверка: {time.strftime('%H:%M:%S', time.localtime(status['last_check'])) if status['last_check'] > 0 else 'Не выполнялась'}

🔄 Мониторинг работает каждые 60 минут"""

    await update.effective_message.reply_text(message)


async def handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = update.effective_message
    user_id = update.effective_user.id
    log.info(f"Received message from user {user_id}: {msg.text[:100]}...")

    # Проверяем, есть ли TikTok ссылки в сообщении
    urls = tiktok_re.findall(msg.text_html or "")
    if not urls:
        log.info(f"No TikTok URLs found in message from user {user_id}")
        return

    log.info(f"Found {len(urls)} TikTok URL(s) in message from user {user_id}")

    for url in urls:
        log.info(f"Processing URL: {url}")
        typing = asyncio.create_task(_keep_typing(context.bot, msg.chat_id))
        try:
            kind, data = await asyncio.to_thread(fetch, url)
            log.info(f"Successfully fetched {kind} from {url}")
        except Exception as e:
            log.error(f"Failed to fetch {url}: {e}")
            typing.cancel()
            await _quiet_cancel(typing)
            await msg.reply_text(
                f"❌ Ошибка при скачивании: {e}", reply_to_message_id=msg.id
            )
            continue
        typing.cancel()
        await _quiet_cancel(typing)

        if kind == "video":
            log.info(f"Sending video to user {user_id}")
            with tempfile.NamedTemporaryFile("wb", suffix=".mp4") as tf:
                tf.write(data)
                tf.flush()
                await msg.chat.send_action(ChatAction.UPLOAD_VIDEO)
                await msg.reply_video(
                    open(tf.name, "rb"),
                    reply_to_message_id=msg.id,
                    supports_streaming=True,
                )
        else:
            log.info(f"Sending {len(data)} images to user {user_id}")
            await msg.chat.send_action(ChatAction.UPLOAD_PHOTO)
            for i in range(0, len(data), 10):
                media = []
                for img in data[i : i + 10]:
                    buf = io.BytesIO(img)
                    buf.name = "img.jpg"
                    media.append(InputMediaPhoto(media=buf))
                await msg.reply_media_group(media=media, reply_to_message_id=msg.id)


async def _keep_typing(bot, chat_id):
    while True:
        try:
            await bot.send_chat_action(chat_id=chat_id, action=ChatAction.TYPING)
        except Exception:
            pass
        await asyncio.sleep(4)


async def _quiet_cancel(task):
    try:
        await task
    except asyncio.CancelledError:
        pass


async def error_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """Обработчик ошибок с подробным логированием"""
    log.error(f"Update {update} caused error {context.error}")
    if update and update.effective_message:
        try:
            await update.effective_message.reply_text(
                "❌ Произошла ошибка при обработке сообщения. Попробуйте еще раз."
            )
        except Exception as e:
            log.error(f"Failed to send error message: {e}")


def main():
    log.info("Starting TikTok Downloader Bot...")

    # Проверяем доступность прокси
    proxy_url = "http://127.0.0.1:8080"
    try:
        import requests

        response = requests.get(
            "http://httpbin.org/ip",
            proxies={"http": proxy_url, "https": proxy_url},
            timeout=5,
        )
        log.info(f"Proxy is working: {response.json()}")
    except Exception as e:
        log.warning(f"Proxy test failed: {e}. Bot will work without proxy.")
        proxy_url = None

    # Создаем приложение
    builder = Application.builder().token(TOKEN)

    if proxy_url:
        builder = (
            builder.proxy(proxy_url).http_version("1.1").get_updates_http_version("1.1")
        )

    app = builder.read_timeout(20).build()

    # Добавляем обработчики
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(CommandHandler("help", cmd_help))
    app.add_handler(CommandHandler("status", cmd_status))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handler))
    app.add_error_handler(error_handler)

    log.info("Bot is ready to receive messages...")

    # Запускаем бота
    try:
        app.run_polling(stop_signals=())
    except (NetworkError, TimedOut) as e:
        log.error("fatal network error: %s", e)
    except Exception as e:
        log.error("fatal error: %s", e)


if __name__ == "__main__":
    main()
