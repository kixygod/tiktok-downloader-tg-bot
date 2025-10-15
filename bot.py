import os, re, logging, tempfile, asyncio, io
from downloader import fetch
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
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ttbot")
tiktok_re = re.compile(r"https?://(?:[a-z]+\.)?tiktok\.com/[^\s]+")


async def cmd_start(update: Update, _):
    await update.effective_message.reply_text(
        "Присылай ссылки на TikTok – скачаю видео/картинки."
    )


async def handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = update.effective_message
    for url in tiktok_re.findall(msg.text_html or ""):
        typing = asyncio.create_task(_keep_typing(context.bot, msg.chat_id))
        try:
            kind, data = await asyncio.to_thread(fetch, url)
        except Exception as e:
            typing.cancel()
            await _quiet_cancel(typing)
            await msg.reply_text(f"❌ {e}", reply_to_message_id=msg.id)
            continue
        typing.cancel()
        await _quiet_cancel(typing)

        if kind == "video":
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


def main():
    # Настройка прокси для Telegram API
    proxy_url = "http://127.0.0.1:8080"

    app = (
        Application.builder()
        .token(TOKEN)
        .proxy(proxy_url)
        .http_version("1.1")
        .get_updates_http_version("1.1")
        .read_timeout(20)
        .build()
    )
    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handler))
    app.add_error_handler(lambda u, c: log.error("unhandled: %s", c.error))
    try:
        app.run_polling(stop_signals=())
    except (NetworkError, TimedOut) as e:
        log.error("fatal network error: %s", e)


if __name__ == "__main__":
    main()
