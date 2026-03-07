import type { Context } from "grammy";
import type { Queue } from "bullmq";
import { pool } from "./db";
import { fmtBytes, fmtDuration, escapeHtml } from "./utils";
import { adminChatId } from "./config";

export function isAdmin(chatId: number): boolean {
  return adminChatId !== null && chatId === adminChatId;
}

export async function handleAdminCommand(
  ctx: Context,
  queue: Queue
): Promise<boolean> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined || !isAdmin(chatId)) return false;

  const text: string = (ctx.message?.text || "").trim();
  if (!text.startsWith("/")) return false;

  const [cmd, ...args] = text.split(/\s+/);

  switch (cmd) {
    case "/stats":
      return await cmdStats(ctx, args);
    case "/today":
      return await cmdPeriod(ctx, "today");
    case "/week":
      return await cmdPeriod(ctx, "week");
    case "/month":
      return await cmdPeriod(ctx, "month");
    case "/all":
      return await cmdPeriod(ctx, "all");
    case "/top":
      return await cmdTop(ctx, args);
    case "/errors":
      return await cmdErrors(ctx, args);
    case "/live":
      return await cmdLive(ctx, queue);
    case "/help":
      return await cmdHelp(ctx);
    default:
      return false;
  }
}

async function cmdHelp(ctx: Context): Promise<boolean> {
  const msg = [
    "<b>📊 Админ-команды</b>",
    "",
    "/stats — сводка (24ч / 7д / 30д / всё время)",
    "/today — детали за сегодня",
    "/week — детали за неделю",
    "/month — детали за месяц",
    "/all — за всё время",
    "/top [N] — топ пользователей по использованию",
    "/errors [N] — последние ошибки",
    "/live — текущая очередь и воркеры",
    "/help — эта справка",
  ].join("\n");
  await ctx.reply(msg, { parse_mode: "HTML" });
  return true;
}

async function cmdStats(ctx: Context, _args: string[]): Promise<boolean> {
  const now = Date.now();
  const { rows } = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE ts >= $1)                            AS d_total,
      COUNT(*) FILTER (WHERE ts >= $1 AND status='success')       AS d_ok,
      COUNT(*) FILTER (WHERE ts >= $1 AND status='failed')        AS d_fail,
      COUNT(*) FILTER (WHERE ts >= $2)                            AS w_total,
      COUNT(*) FILTER (WHERE ts >= $3)                            AS m_total,
      COUNT(*)                                                     AS all_total,
      COALESCE(SUM(bytes), 0)                                      AS all_bytes,
      COALESCE(AVG(duration_ms) FILTER (WHERE duration_ms > 0), 0) AS avg_ms,
      COUNT(DISTINCT chat_id)                                      AS unique_chats,
      COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)   AS unique_users
    FROM jobs
  `,
    [now - 86400_000, now - 7 * 86400_000, now - 30 * 86400_000]
  );

  const r = rows[0] as Record<string, string | number>;
  const dTotal = Number(r.d_total);
  const successRate = dTotal > 0 ? Math.round((Number(r.d_ok) / dTotal) * 100) : 0;

  const msg = [
    "<b>📊 Статистика бота</b>",
    "",
    `<b>За 24ч:</b> ${r.d_total} запросов (✅ ${r.d_ok} / ❌ ${r.d_fail}) — ${successRate}%`,
    `<b>За 7д:</b>  ${r.w_total}`,
    `<b>За 30д:</b> ${r.m_total}`,
    `<b>Всего:</b>  ${r.all_total}`,
    "",
    `📦 Трафик: ${fmtBytes(Number(r.all_bytes))}`,
    `⏱ Среднее время: ${fmtDuration(Math.round(Number(r.avg_ms)))}`,
    `👥 Уник. чатов: ${r.unique_chats}`,
    `👤 Уник. юзеров: ${r.unique_users}`,
  ].join("\n");

  await ctx.reply(msg, { parse_mode: "HTML" });
  return true;
}

async function cmdPeriod(ctx: Context, period: string): Promise<boolean> {
  const now = Date.now();
  let since = 0;
  let label = "за всё время";
  switch (period) {
    case "today":
      since = now - 86400_000;
      label = "за 24 часа";
      break;
    case "week":
      since = now - 7 * 86400_000;
      label = "за 7 дней";
      break;
    case "month":
      since = now - 30 * 86400_000;
      label = "за 30 дней";
      break;
  }

  const { rows } = await pool.query(
    `
    SELECT
      COUNT(*)                                                     AS total,
      COUNT(*) FILTER (WHERE status = 'success')                   AS ok,
      COUNT(*) FILTER (WHERE status = 'compressed')                AS compressed,
      COUNT(*) FILTER (WHERE status = 'too_large')                 AS too_large,
      COUNT(*) FILTER (WHERE status = 'failed')                    AS failed,
      COALESCE(SUM(bytes), 0)                                      AS total_bytes,
      COALESCE(AVG(duration_ms) FILTER (WHERE duration_ms > 0), 0) AS avg_ms,
      COALESCE(MIN(duration_ms) FILTER (WHERE duration_ms > 0), 0) AS min_ms,
      COALESCE(MAX(duration_ms) FILTER (WHERE duration_ms > 0), 0) AS max_ms,
      COUNT(DISTINCT chat_id)                                      AS chats,
      COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL)   AS users
    FROM jobs
    WHERE ts >= $1
  `,
    [since]
  );

  const r = rows[0] as Record<string, string | number>;

  const platformQ = await pool.query(
    `
    SELECT platform, COUNT(*) AS cnt
    FROM jobs WHERE ts >= $1 AND platform IS NOT NULL
    GROUP BY platform ORDER BY cnt DESC
  `,
    [since]
  );

  const platforms = platformQ.rows
    .map((p: { platform: string; cnt: string }) => `  ${p.platform}: ${p.cnt}`)
    .join("\n");

  const msg = [
    `<b>📈 Детали ${label}</b>`,
    "",
    `Всего: <b>${r.total}</b>`,
    `  ✅ Успешно: ${r.ok}`,
    `  🗜 Сжато: ${r.compressed}`,
    `  📏 Слишком большие: ${r.too_large}`,
    `  ❌ Ошибки: ${r.failed}`,
    "",
    `📦 Трафик: ${fmtBytes(Number(r.total_bytes))}`,
    `⏱ Время: avg ${fmtDuration(Math.round(Number(r.avg_ms)))} / min ${fmtDuration(Number(r.min_ms))} / max ${fmtDuration(Number(r.max_ms))}`,
    `👥 Чатов: ${r.chats} | Юзеров: ${r.users}`,
    "",
    `<b>Платформы:</b>`,
    platforms || "  нет данных",
  ].join("\n");

  await ctx.reply(msg, { parse_mode: "HTML" });
  return true;
}

async function cmdTop(ctx: Context, args: string[]): Promise<boolean> {
  const limit = Math.min(Number(args[0]) || 10, 50);
  const { rows } = await pool.query(
    `
    SELECT user_id, 
           MAX(first_name) AS name,
           MAX(username) AS username,
           COUNT(*) AS cnt,
           COALESCE(SUM(bytes), 0) AS total_bytes,
           MAX(ts) AS last_used
    FROM jobs
    WHERE user_id IS NOT NULL
    GROUP BY user_id
    ORDER BY cnt DESC
    LIMIT $1
  `,
    [limit]
  );

  const lines = rows.map(
    (
      r: { name: string; username: string; user_id: number; cnt: number; total_bytes: number; last_used: number },
      i: number
    ) => {
      const name = r.name || r.username ? escapeHtml(r.name || r.username) : String(r.user_id);
      const ago = Math.round((Date.now() - Number(r.last_used)) / 3600_000);
      return `${i + 1}. ${name} — ${r.cnt} запросов (${fmtBytes(Number(r.total_bytes))}, ${ago}ч назад)`;
    }
  );

  const msg = [`<b>🏆 Топ-${limit} пользователей</b>`, "", ...lines].join("\n");

  await ctx.reply(msg, { parse_mode: "HTML" });
  return true;
}

async function cmdErrors(ctx: Context, args: string[]): Promise<boolean> {
  const limit = Math.min(Number(args[0]) || 10, 30);
  const { rows } = await pool.query(
    `
    SELECT ts, url, chat_id, first_name, error_message, duration_ms
    FROM jobs
    WHERE status = 'failed'
    ORDER BY ts DESC
    LIMIT $1
  `,
    [limit]
  );

  if (rows.length === 0) {
    await ctx.reply("🎉 Ошибок не найдено!");
    return true;
  }

  const lines = rows.map(
    (r: { ts: number; chat_id: number; first_name: string; error_message: string }) => {
      const ago = Math.round((Date.now() - Number(r.ts)) / 60_000);
      const name = r.first_name ? escapeHtml(r.first_name) : String(r.chat_id);
      const err = r.error_message
        ? escapeHtml(r.error_message.slice(0, 80))
        : "нет деталей";
      return `• <b>${ago}м назад</b> | ${name}\n  ${err}`;
    }
  );

  const msg = [`<b>❌ Последние ${rows.length} ошибок</b>`, "", ...lines].join("\n");

  await ctx.reply(msg, { parse_mode: "HTML" });
  return true;
}

async function cmdLive(ctx: Context, queue: Queue): Promise<boolean> {
  const waiting = await queue.getWaitingCount();
  const active = await queue.getActiveCount();
  const delayed = await queue.getDelayedCount();
  const failed = await queue.getFailedCount();

  const last5min = Date.now() - 300_000;
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM jobs WHERE ts >= $1`,
    [last5min]
  );

  const r = rows[0] as { cnt: string };
  const msg = [
    "<b>🔴 Live-статус</b>",
    "",
    `В очереди: ${waiting}`,
    `Обрабатывается: ${active}`,
    `Отложенные: ${delayed}`,
    `Провалено (в очереди): ${failed}`,
    "",
    `За последние 5 мин: ${r.cnt} запросов`,
  ].join("\n");

  await ctx.reply(msg, { parse_mode: "HTML" });
  return true;
}
