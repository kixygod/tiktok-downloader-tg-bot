import { Bot, GrammyError, HttpError } from "grammy";
import Fastify from "fastify";
import fastifyBasicAuth from "@fastify/basic-auth";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { Pool } from "pg";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const token = process.env.BOT_TOKEN!;
const sizeLimitMB = Number(process.env.SIZE_LIMIT_MB ?? "50");
const adminChatId = process.env.ADMIN_CHAT_ID
  ? Number(process.env.ADMIN_CHAT_ID)
  : null;

console.log("🔧 Environment variables:");
console.log(`  BOT_TOKEN: ${token ? "SET" : "NOT SET"}`);
console.log(`  DATABASE_URL: ${process.env.DATABASE_URL ? "SET" : "NOT SET"}`);
console.log(`  ADMIN_CHAT_ID: ${adminChatId ?? "NOT SET"}`);
console.log(`  HTTP_PROXY: ${process.env.HTTP_PROXY}`);
console.log(`  HTTPS_PROXY: ${process.env.HTTPS_PROXY}`);

if (!token) {
  console.error("BOT_TOKEN is not set!");
  process.exit(1);
}

const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  console.log(`🔗 Configuring global proxy: ${proxyUrl}`);
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
  console.log("✅ Global proxy configured for all HTTP requests");
} else {
  console.log("⚠️ No proxy configured - using direct connection");
}

const bot = new Bot(token);

const redisUrl = process.env.REDIS_URL!;
const queueName = process.env.QUEUE_NAME || "tiktok";
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue(queueName, { connection });

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function initDB() {
  const MAX_RETRIES = 20;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS jobs (
          id            SERIAL PRIMARY KEY,
          ts            BIGINT NOT NULL,
          url           TEXT NOT NULL,
          chat_id       BIGINT NOT NULL,
          user_id       BIGINT,
          username      TEXT,
          first_name    TEXT,
          platform      TEXT,
          status        TEXT NOT NULL,
          bytes         BIGINT NOT NULL DEFAULT 0,
          duration_ms   INTEGER NOT NULL DEFAULT 0,
          error_message TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE INDEX IF NOT EXISTS idx_jobs_ts ON jobs (ts);
        CREATE INDEX IF NOT EXISTS idx_jobs_chat_id ON jobs (chat_id);
        CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
        CREATE INDEX IF NOT EXISTS idx_jobs_platform ON jobs (platform);
        CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs (created_at);
        CREATE INDEX IF NOT EXISTS idx_jobs_ts_status ON jobs (ts, status);
      `);
      console.log("✅ PostgreSQL tables initialized");
      return;
    } catch (err: any) {
      console.log(
        `⏳ PostgreSQL not ready (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`
      );
      if (attempt === MAX_RETRIES) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

const SUPPORTED_URL_PATTERNS: { pattern: RegExp; platform: string }[] = [
  {
    pattern: /(https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/[^\s]+)/i,
    platform: "tiktok",
  },
  {
    pattern: /(https?:\/\/(?:www\.)?youtube\.com\/shorts\/[^\s]+)/i,
    platform: "youtube",
  },
  {
    pattern: /(https?:\/\/(?:www\.)?vk\.com\/clip-[^\s]+)/i,
    platform: "vk",
  },
];

function extractSupportedUrl(
  text: string
): { url: string; platform: string } | null {
  for (const { pattern, platform } of SUPPORTED_URL_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[0]) return { url: match[0], platform };
  }
  return null;
}

const AVG_TIME_CACHE_TTL_MS = 60_000;
let avgTimeCache: { value: number; expiresAt: number } | null = null;

async function getAverageProcessingTime(): Promise<number> {
  if (avgTimeCache && Date.now() < avgTimeCache.expiresAt) {
    return avgTimeCache.value;
  }
  try {
    const since = Date.now() - 7 * 24 * 3600_000;
    const { rows } = await pool.query(
      `SELECT AVG(duration_ms) as avg FROM jobs WHERE status = 'success' AND ts > $1 AND duration_ms > 0`,
      [since]
    );
    const value = Math.round(rows[0]?.avg ?? 0);
    avgTimeCache = { value, expiresAt: Date.now() + AVG_TIME_CACHE_TTL_MS };
    return value;
  } catch {
    return 0;
  }
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function isAdmin(chatId: number): boolean {
  return adminChatId !== null && chatId === adminChatId;
}

async function handleAdminCommand(ctx: any): Promise<boolean> {
  const chatId = ctx.chat.id;
  if (!isAdmin(chatId)) return false;

  const text: string = (ctx.message.text || "").trim();
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
      return await cmdLive(ctx);
    case "/help":
      return await cmdHelp(ctx);
    default:
      return false;
  }
}

async function cmdHelp(ctx: any): Promise<boolean> {
  const msg = [
    "<b>📊 Админ-команды</b>",
    "",
    "/stats — сводка (24ч / 7д / 30д / всё время)",
    "/today — детали за сегодня",
    "/week — детали за неделю",
    "/month — детали за месяц",
    "/all — за всё время",
    "/top [N] — топ чатов по использованию",
    "/errors [N] — последние ошибки",
    "/live — текущая очередь и воркеры",
    "/help — эта справка",
  ].join("\n");
  await ctx.reply(msg, { parse_mode: "HTML" });
  return true;
}

async function cmdStats(ctx: any, _args: string[]): Promise<boolean> {
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

  const r = rows[0];
  const successRate =
    r.d_total > 0 ? Math.round((r.d_ok / r.d_total) * 100) : 0;

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

async function cmdPeriod(ctx: any, period: string): Promise<boolean> {
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

  const r = rows[0];

  const platformQ = await pool.query(
    `
    SELECT platform, COUNT(*) AS cnt
    FROM jobs WHERE ts >= $1 AND platform IS NOT NULL
    GROUP BY platform ORDER BY cnt DESC
  `,
    [since]
  );

  const platforms = platformQ.rows
    .map((p: any) => `  ${p.platform}: ${p.cnt}`)
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
    `⏱ Время: avg ${fmtDuration(
      Math.round(Number(r.avg_ms))
    )} / min ${fmtDuration(Number(r.min_ms))} / max ${fmtDuration(
      Number(r.max_ms)
    )}`,
    `👥 Чатов: ${r.chats} | Юзеров: ${r.users}`,
    "",
    `<b>Платформы:</b>`,
    platforms || "  нет данных",
  ].join("\n");

  await ctx.reply(msg, { parse_mode: "HTML" });
  return true;
}

async function cmdTop(ctx: any, args: string[]): Promise<boolean> {
  const limit = Math.min(Number(args[0]) || 10, 50);
  const { rows } = await pool.query(
    `
    SELECT chat_id, 
           MAX(first_name) AS name,
           COUNT(*) AS cnt,
           COALESCE(SUM(bytes), 0) AS total_bytes,
           MAX(ts) AS last_used
    FROM jobs
    GROUP BY chat_id
    ORDER BY cnt DESC
    LIMIT $1
  `,
    [limit]
  );

  const lines = rows.map((r: any, i: number) => {
    const name = r.name ? escapeHtml(r.name) : String(r.chat_id);
    const ago = Math.round((Date.now() - Number(r.last_used)) / 3600_000);
    return `${i + 1}. ${name} — ${r.cnt} запросов (${fmtBytes(
      Number(r.total_bytes)
    )}, ${ago}ч назад)`;
  });

  const msg = [`<b>🏆 Топ-${limit} чатов</b>`, "", ...lines].join("\n");

  await ctx.reply(msg, { parse_mode: "HTML" });
  return true;
}

async function cmdErrors(ctx: any, args: string[]): Promise<boolean> {
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

  const lines = rows.map((r: any) => {
    const ago = Math.round((Date.now() - Number(r.ts)) / 60_000);
    const name = r.first_name ? escapeHtml(r.first_name) : String(r.chat_id);
    const err = r.error_message
      ? escapeHtml(r.error_message.slice(0, 80))
      : "нет деталей";
    return `• <b>${ago}м назад</b> | ${name}\n  ${err}`;
  });

  const msg = [`<b>❌ Последние ${rows.length} ошибок</b>`, "", ...lines].join(
    "\n"
  );

  await ctx.reply(msg, { parse_mode: "HTML" });
  return true;
}

async function cmdLive(ctx: any): Promise<boolean> {
  const waiting = await queue.getWaitingCount();
  const active = await queue.getActiveCount();
  const delayed = await queue.getDelayedCount();
  const failed = await queue.getFailedCount();

  const last5min = Date.now() - 300_000;
  const { rows } = await pool.query(
    `SELECT COUNT(*) AS cnt FROM jobs WHERE ts >= $1`,
    [last5min]
  );

  const msg = [
    "<b>🔴 Live-статус</b>",
    "",
    `В очереди: ${waiting}`,
    `Обрабатывается: ${active}`,
    `Отложенные: ${delayed}`,
    `Провалено (в очереди): ${failed}`,
    "",
    `За последние 5 мин: ${rows[0].cnt} запросов`,
  ].join("\n");

  await ctx.reply(msg, { parse_mode: "HTML" });
  return true;
}

bot.on("message:text", async (ctx: any) => {
  const text = (ctx.message.text || ctx.message.caption || "").trim();

  if (text === "/start") {
    await ctx.reply(
      isAdmin(ctx.chat.id)
        ? "🟢 Ты админ! Команды: /help"
        : "👋 Привет! Отправь ссылку на TikTok, YouTube Shorts или VK Clips."
    );
    return;
  }

  if (await handleAdminCommand(ctx)) return;

  if (text.includes("instagram.com")) {
    await ctx.reply(
      "❌ К сожалению, бот не умеет работать с Instagram.\n\nПоддерживаются:\n• TikTok\n• YouTube Shorts\n• VK Clips",
      {
        reply_to_message_id: ctx.message.message_id,
        allow_sending_without_reply: true,
      }
    );
    return;
  }

  const extracted = extractSupportedUrl(text);
  if (!extracted) return;

  const avgTime = await getAverageProcessingTime();
  const avgTimeSeconds = Math.round(avgTime / 1000);

  const message =
    avgTime > 0
      ? `Обрабатываю ссылку…\nСреднее время ожидания: ${avgTimeSeconds}с 😉`
      : "Обрабатываю ссылку…";

  const ack = await ctx.reply(message, {
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true,
  });

  const from = ctx.message.from;

  await queue.add(
    "download",
    {
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      ackMessageId: ack.message_id,
      url: extracted.url,
      platform: extracted.platform,
      userId: from?.id ?? null,
      username: from?.username ?? null,
      firstName: from?.first_name ?? null,
      sizeLimitMB,
    },
    {
      removeOnComplete: 500,
      removeOnFail: 500,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      jobId: `${ctx.chat.id}:${ctx.message.message_id}`,
    }
  );
});

bot.catch((err: any) => {
  if (err.error instanceof GrammyError) {
    console.error("Telegram API error:", err.error.description);
  } else if (err.error instanceof HttpError) {
    console.error("HTTP error:", err.error);
  } else {
    console.error("Unknown error:", err.error);
  }
});

const fastify = Fastify({ logger: true });

async function startServer() {
  fastify.get("/health", async () => ({ ok: true }));

  fastify.post("/stats", async (request: any) => {
    const {
      ts,
      url,
      status,
      bytes,
      duration_ms,
      chat_id,
      user_id,
      username,
      first_name,
      platform,
      error_message,
    } = request.body as any;

    await pool.query(
      `INSERT INTO jobs (ts, url, chat_id, user_id, username, first_name, platform, status, bytes, duration_ms, error_message)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        ts,
        url,
        chat_id,
        user_id ?? null,
        username ?? null,
        first_name ?? null,
        platform ?? null,
        status,
        bytes,
        duration_ms,
        error_message ?? null,
      ]
    );

    return { ok: true };
  });

  const API_CACHE_TTL_MS = 10_000;
  const apiCache = new Map<string, { data: any; expiresAt: number }>();

  function getCached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const cached = apiCache.get(key);
    if (cached && Date.now() < cached.expiresAt)
      return Promise.resolve(cached.data);
    return fetcher().then((data) => {
      apiCache.set(key, { data, expiresAt: Date.now() + API_CACHE_TTL_MS });
      return data;
    });
  }

  fastify.get("/api/stats", async (request: any) => {
    return getCached("stats", async () => {
      const now = Date.now();
      const { rows } = await pool.query(
        `
      SELECT
        COUNT(*) FILTER (WHERE ts >= $1) AS d_total,
        COUNT(*) FILTER (WHERE ts >= $2) AS w_total,
        COUNT(*) FILTER (WHERE ts >= $3) AS m_total,
        COUNT(*)                          AS all_total,
        COALESCE(SUM(bytes), 0)           AS all_bytes,
        COALESCE(AVG(duration_ms) FILTER (WHERE duration_ms > 0), 0) AS avg_ms,
        COUNT(*) FILTER (WHERE status = 'success')    AS total_success,
        COUNT(*) FILTER (WHERE status = 'failed')     AS total_failed,
        COUNT(*) FILTER (WHERE status = 'compressed') AS total_compressed,
        COUNT(*) FILTER (WHERE status = 'too_large')  AS total_too_large,
        COUNT(DISTINCT chat_id)                        AS unique_chats,
        COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS unique_users
      FROM jobs
    `,
        [now - 86400_000, now - 7 * 86400_000, now - 30 * 86400_000]
      );

      const r = rows[0];
      const proxyEnabled = !!(
        process.env.HTTP_PROXY ||
        process.env.HTTPS_PROXY ||
        process.env.ALL_PROXY
      );

      return {
        daily: Number(r.d_total),
        weekly: Number(r.w_total),
        monthly: Number(r.m_total),
        total: Number(r.all_total),
        traffic: Math.round((Number(r.all_bytes) / 1024 / 1024) * 10) / 10,
        avgDuration: Math.round(Number(r.avg_ms)),
        totalSuccess: Number(r.total_success),
        totalFailed: Number(r.total_failed),
        totalCompressed: Number(r.total_compressed),
        totalTooLarge: Number(r.total_too_large),
        uniqueChats: Number(r.unique_chats),
        uniqueUsers: Number(r.unique_users),
        proxyEnabled,
      };
    });
  });

  fastify.get("/api/charts", async (request: any) => {
    return getCached("charts", async () => {
      const now = Date.now();

      const hourlyQ = await pool.query(
        `
      SELECT
        EXTRACT(HOUR FROM to_timestamp(ts / 1000.0))::int AS hour,
        COUNT(*) AS count,
        COUNT(*) FILTER (WHERE status = 'success') AS success,
        COUNT(*) FILTER (WHERE status = 'failed')  AS failed
      FROM jobs WHERE ts >= $1
      GROUP BY hour ORDER BY hour
    `,
        [now - 86400_000]
      );

      const dailyQ = await pool.query(
        `
      SELECT
        to_char(to_timestamp(ts / 1000.0), 'YYYY-MM-DD') AS date,
        COUNT(*) AS count,
        COUNT(*) FILTER (WHERE status = 'success') AS success,
        COUNT(*) FILTER (WHERE status = 'failed')  AS failed,
        AVG(duration_ms) FILTER (WHERE duration_ms > 0) AS avg_duration,
        COALESCE(SUM(bytes), 0) AS total_bytes
      FROM jobs WHERE ts >= $1
      GROUP BY date ORDER BY date
    `,
        [now - 30 * 86400_000]
      );

      const platformQ = await pool.query(
        `
      SELECT platform, COUNT(*) AS count
      FROM jobs WHERE ts >= $1 AND platform IS NOT NULL
      GROUP BY platform ORDER BY count DESC
    `,
        [now - 30 * 86400_000]
      );

      const statusQ = await pool.query(
        `
      SELECT status, COUNT(*) AS count
      FROM jobs WHERE ts >= $1
      GROUP BY status
    `,
        [now - 30 * 86400_000]
      );

      return {
        hourly: hourlyQ.rows,
        daily: dailyQ.rows,
        platforms: platformQ.rows,
        statuses: statusQ.rows,
      };
    });
  });

  fastify.get("/api/recent", async (request: any) => {
    const {
      limit = 50,
      offset = 0,
      status,
      platform,
      chat_id,
    } = (request as any).query;

    let where = "WHERE 1=1";
    const params: any[] = [];
    let idx = 1;

    if (status) {
      where += ` AND status = $${idx++}`;
      params.push(status);
    }
    if (platform) {
      where += ` AND platform = $${idx++}`;
      params.push(platform);
    }
    if (chat_id) {
      where += ` AND chat_id = $${idx++}`;
      params.push(Number(chat_id));
    }

    const countQ = await pool.query(
      `SELECT COUNT(*) AS total FROM jobs ${where}`,
      params
    );

    const dataQ = await pool.query(
      `SELECT id, ts, url, chat_id, user_id, username, first_name, platform, status, bytes, duration_ms, error_message
       FROM jobs ${where}
       ORDER BY ts DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, Math.min(Number(limit), 200), Number(offset)]
    );

    return {
      total: Number(countQ.rows[0].total),
      items: dataQ.rows,
    };
  });

  await fastify.register(async function (fastify) {
    await fastify.register(fastifyBasicAuth, {
      validate: async (username: any, password: any) => {
        const [u, p] = (
          process.env.DASHBOARD_BASIC_AUTH ?? "admin:admin"
        ).split(":");
        if (username !== u || password !== p) throw new Error("Auth failed");
      },
      authenticate: true,
    });

    fastify.after(() => {
      fastify.addHook("onRequest", fastify.basicAuth);
    });

    fastify.get("/dashboard", async (_req: any, reply: any) => {
      try {
        const html = readFileSync(
          join(__dirname, "..", "dashboard.html"),
          "utf-8"
        );
        reply.type("text/html").send(html);
      } catch (error) {
        console.error("Error reading dashboard.html:", error);
        reply.status(500).send("Error loading dashboard");
      }
    });
  });

  fastify.listen({ port: 3000, host: "0.0.0.0" }, (err: any, address: any) => {
    if (err) {
      console.error("Error starting server:", err);
      process.exit(1);
    }
    console.log(`🚀 Dashboard server listening at ${address}`);
  });
}

async function main() {
  await initDB();
  await startServer();

  bot.catch((err) => console.error("❌ Bot error:", err));

  const me = await bot.api.getMe();
  console.log(`✅ Bot connected: @${me.username} (${me.first_name})`);

  if (adminChatId) {
    bot.api
      .sendMessage(
        adminChatId,
        "🟢 Бот запущен и готов к работе!\n/help — список команд"
      )
      .catch(() => {});
  }

  bot.start();
  console.log("🤖 Bot polling started");
}

main().catch((err) => {
  console.error("❌ Fatal:", err);
  process.exit(1);
});
