#!/usr/bin/env python3
import os, re, io, asyncio, tempfile, shelve, hashlib, atexit, logging, time
from downloader import fetch

from telegram import (
    Update,
    InputMediaPhoto,
    InlineQueryResultCachedVideo,
    InlineQueryResultCachedPhoto,
    InlineQueryResultPhoto,
    InlineQueryResultArticle,
    InputTextMessageContent,
    InlineKeyboardMarkup,
    InlineKeyboardButton,
)
from telegram.constants import ChatAction
from telegram.ext import (
    Application,
    CommandHandler,
    MessageHandler,
    InlineQueryHandler,
    CallbackQueryHandler,
    ContextTypes,
    filters,
)
from telegram.error import NetworkError, TimedOut

TOKEN = os.getenv("TELEGRAM_TOKEN")
TTL_DAYS = int(os.getenv("CACHE_TTL_DAYS", "30"))
MAX_MB = 49
TIMEOUT = 40

URL_RE = re.compile(
    r"""https?://(?:www\.)?(
        (?:vm\.)?tiktok\.com/[^\s]+ |
        instagram\.com/(?:(?:reel|p|tv)/[A-Za-z0-9_\-]+) |
        (?:youtube\.com/watch\?v=|youtu\.be/)[\w\-]{11}
    )""",
    re.VERBOSE,
)

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("ttbot")

CACHE = shelve.open(os.path.join("data", "cache.db"))
atexit.register(CACHE.close)


def _tid(url: str) -> str:
    return hashlib.md5(url.encode()).hexdigest()


def _purge_old():
    now, ttl = time.time(), TTL_DAYS * 86400
    for k in list(CACHE.keys()):
        if now - CACHE[k]["ts"] > ttl:
            del CACHE[k]
    CACHE.sync()


_purge_old()


async def cmd_start(update: Update, _):
    await update.effective_message.reply_text(
        f"Присылай ссылки — скачаю.\n" f"Inline: @{update.get_bot().username} <ссылка>"
    )


async def handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    msg = update.effective_message
    for m in URL_RE.finditer(msg.text_html or ""):
        url = m.group(0)

        typing = asyncio.create_task(_keep_typing(context.bot, msg.chat_id))
        try:
            kind, data = await asyncio.wait_for(
                asyncio.to_thread(fetch, url), timeout=TIMEOUT
            )
        except asyncio.TimeoutError:
            await _cancel_typing(typing)
            await msg.reply_text("⏰ >40 сек. — бросил.", reply_to_message_id=msg.id)
            continue
        except Exception as e:
            await _cancel_typing(typing)
            log.exception("fetch err")
            await msg.reply_text(f"❌ {e}", reply_to_message_id=msg.id)
            continue

        await _cancel_typing(typing)

        if kind == "video":
            if len(data) > MAX_MB * 1024 * 1024:
                await msg.reply_text(
                    "⚠️ Видео > 50 МБ (лимит Bot API).", reply_to_message_id=msg.id
                )
                continue
            with tempfile.NamedTemporaryFile("wb", suffix=".mp4") as tf:
                tf.write(data)
                tf.flush()
                await msg.chat.send_action(ChatAction.UPLOAD_VIDEO)
                await msg.reply_video(
                    tf.name, reply_to_message_id=msg.id, supports_streaming=True
                )
        else:
            await msg.chat.send_action(ChatAction.UPLOAD_PHOTO)
            for i in range(0, len(data), 10):
                media = [InputMediaPhoto(io.BytesIO(img)) for img in data[i : i + 10]]
                await msg.reply_media_group(media, reply_to_message_id=msg.id)


async def inline_query(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = update.inline_query.query.strip()
    m = URL_RE.search(q)
    if not m:
        await update.inline_query.answer(
            [
                InlineQueryResultArticle(
                    id="help",
                    title="Как пользоваться?",
                    input_message_content=InputTextMessageContent(
                        f"Пришлите ссылку боту в личку, "
                        f"а потом: @{update.get_bot().username} <ссылка>"
                    ),
                )
            ],
            cache_time=0,
            is_personal=True,
        )
        return

    url, tid = m.group(0), _tid(m.group(0))
    cached = CACHE.get(tid)
    if cached:
        await update.inline_query.answer(
            _cached_results(tid, cached), cache_time=3600, is_personal=True
        )
        return

    try:
        kind, data = await asyncio.wait_for(
            asyncio.to_thread(fetch, url, inline=True), timeout=TIMEOUT
        )
    except Exception as e:
        log.warning("inline fetch fail: %s", e)
        await update.inline_query.answer(
            [
                InlineQueryResultArticle(
                    id="err",
                    title="❌ Ошибка",
                    input_message_content=InputTextMessageContent(str(e)),
                )
            ],
            cache_time=0,
            is_personal=True,
        )
        return

    if kind == "photo_url":
        photos = [
            InlineQueryResultPhoto(
                id=f"{tid}_{n}",
                photo_url=u,
                thumbnail_url=u,
                title=f"Фото {n+1}/{len(data)}",
            )
            for n, u in enumerate(data)
        ][:50]
        await update.inline_query.answer(
            photos + [_album_button(tid, len(data))], cache_time=3600, is_personal=True
        )
        CACHE[tid] = {"t": "photo_url", "ids": data, "ts": time.time()}
        CACHE.sync()
        return

    await update.inline_query.answer(
        [
            InlineQueryResultArticle(
                id="pending",
                title="⏳ Загружаю…",
                input_message_content=InputTextMessageContent("⏳ Скачиваю…"),
            )
        ],
        cache_time=1,
        is_personal=True,
    )

    context.application.create_task(_download_dm(tid, url, kind, data, context, update))


def _cached_results(tid, item):
    if item["t"] == "video":
        return [
            InlineQueryResultCachedVideo(
                id=tid, video_file_id=item["ids"][0], title="Video"
            )
        ]
    if item["t"] == "photo_url":
        photos = [
            InlineQueryResultPhoto(
                id=f"{tid}_{n}",
                photo_url=u,
                thumbnail_url=u,
                title=f"Фото {n+1}/{len(item['ids'])}",
            )
            for n, u in enumerate(item["ids"])
        ][:50]
        return photos + [_album_button(tid, len(item["ids"]))]

    return [
        InlineQueryResultCachedPhoto(
            id=f"{tid}_{n}", photo_file_id=fid, title=f"Фото {n+1}/{len(item['ids'])}"
        )
        for n, fid in enumerate(item["ids"])
    ][:50]


def _album_button(tid: str, n: int) -> InlineQueryResultArticle:
    return InlineQueryResultArticle(
        id=f"{tid}_sendall",
        title=f"📚 Отправить все ({n})",
        input_message_content=InputTextMessageContent(
            "Нажмите кнопку ниже, чтобы получить альбом"
        ),
        reply_markup=InlineKeyboardMarkup.from_button(
            InlineKeyboardButton("📚 Отправить все", callback_data=f"ALBUM:{tid}")
        ),
    )


async def on_album_cb(update: Update, context: ContextTypes.DEFAULT_TYPE):
    cq = update.callback_query
    if not cq.data or not cq.data.startswith("ALBUM:"):
        return
    await cq.answer("📬 Проверьте личку!")
    tid = cq.data.split(":", 1)[1]
    item = CACHE.get(tid)
    if not item:
        await cq.edit_message_text("⚠️ Кэш истёк, попробуйте ещё раз.")
        return
    for i in range(0, len(item["ids"]), 10):
        media = [InputMediaPhoto(u) for u in item["ids"][i : i + 10]]
        await context.bot.send_media_group(cq.from_user.id, media=media)


async def _download_dm(tid, url, kind, data, context, update):
    try:
        if kind not in ("video", "photo"):
            kind, data = await asyncio.to_thread(fetch, url)

        if kind == "video":
            if len(data) > MAX_MB * 1024 * 1024:
                await context.bot.send_message(
                    update.inline_query.from_user.id,
                    "⚠️ Видео > 50 МБ — слишком для inline.",
                )
                return
            buf = io.BytesIO(data)
            buf.name = "video.mp4"
            msg = await context.bot.send_video(
                update.inline_query.from_user.id, buf, supports_streaming=True
            )
            ids = [msg.video.file_id]
        else:
            ids = []
            for img in data:
                msg = await context.bot.send_photo(
                    update.inline_query.from_user.id, io.BytesIO(img)
                )
                ids.append(msg.photo[-1].file_id)

        CACHE[tid] = {"t": kind, "ids": ids, "ts": time.time()}
        CACHE.sync()

    except Exception as e:
        log.exception("dm fetch fail")
        await context.bot.send_message(
            update.inline_query.from_user.id, f"❌ Не удалось скачать ({e})"
        )


async def _keep_typing(bot, chat_id):
    while True:
        try:
            await bot.send_chat_action(chat_id, ChatAction.TYPING)
        except Exception:
            pass
        await asyncio.sleep(4)


async def _cancel_typing(t: asyncio.Task):
    t.cancel()
    try:
        await t
    except asyncio.CancelledError:
        pass


def main():
    app = (
        Application.builder().token(TOKEN).read_timeout(20).http_version("1.1").build()
    )

    app.add_handler(CommandHandler("start", cmd_start))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handler))
    app.add_handler(InlineQueryHandler(inline_query))
    app.add_handler(CallbackQueryHandler(on_album_cb))
    app.add_error_handler(lambda u, c: log.error("err: %s", c.error))

    try:
        app.run_polling(stop_signals=())
    except (NetworkError, TimedOut) as e:
        log.error("fatal: %s", e)


if __name__ == "__main__":
    main()
