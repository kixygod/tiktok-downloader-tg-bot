import { Bot, GrammyError, HttpError } from "grammy";
import Fastify from "fastify";
import fastifyBasicAuth from "@fastify/basic-auth";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import Database from "better-sqlite3";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const token = process.env.BOT_TOKEN!;
const sizeLimitMB = Number(process.env.SIZE_LIMIT_MB ?? "50");

console.log("🔧 Environment variables:");
console.log(`  BOT_TOKEN: ${token ? "SET" : "NOT SET"}`);
console.log(`  HTTP_PROXY: ${process.env.HTTP_PROXY}`);
console.log(`  HTTPS_PROXY: ${process.env.HTTPS_PROXY}`);
console.log(`  ALL_PROXY: ${process.env.ALL_PROXY}`);
console.log(`  NO_PROXY: ${process.env.NO_PROXY}`);

if (!token) {
  console.error("BOT_TOKEN is not set!");
  process.exit(1);
}

const bot = new Bot(token);

// Настраиваем прокси глобально для всех HTTP запросов
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
if (proxyUrl) {
  console.log(`🔗 Configuring global proxy: ${proxyUrl}`);

  // Устанавливаем глобальный прокси для всех HTTP запросов
  setGlobalDispatcher(new ProxyAgent(proxyUrl));

  console.log("✅ Global proxy configured for all HTTP requests");
} else {
  console.log("⚠️ No proxy configured - using direct connection");
}

const redisUrl = process.env.REDIS_URL!;
const queueName = process.env.QUEUE_NAME || "tiktok";
const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});
const queue = new Queue(queueName, { connection });

// === БД для статов (SQLite) ===
const db = new Database("/app/data/stats.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    url TEXT NOT NULL,
    chat_id INTEGER NOT NULL,
    status TEXT NOT NULL,       -- success|too_large|failed|compressed
    bytes INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0
  );
`);

const SUPPORTED_URL_PATTERNS = [
  /(https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/[^\s]+)/i,
  /(https?:\/\/(?:www\.)?youtube\.com\/shorts\/[^\s]+)/i,
  /(https?:\/\/(?:www\.)?vk\.com\/clip-[^\s]+)/i,
  /(https?:\/\/(?:www\.)?instagram\.com\/reel\/[^\s]+)/i,
];

function extractSupportedUrl(text: string): string | null {
  for (const pattern of SUPPORTED_URL_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[0]) {
      return match[0];
    }
  }
  return null;
}

// Функция для получения среднего времени обработки
function getAverageProcessingTime(): number {
  try {
    const stmt = db.prepare(`
      SELECT AVG(duration_ms) as avg_duration
      FROM jobs
      WHERE status = 'success'
      AND ts > ?
      AND duration_ms > 0
    `);
    const result = stmt.get(Date.now() - 7 * 24 * 3600 * 1000) as any; // За последние 7 дней
    return Math.round(result?.avg_duration || 0);
  } catch (error) {
    console.error("Error getting average processing time:", error);
    return 0;
  }
}

bot.on("message:text", async (ctx: any) => {
  const text = ctx.message.text || ctx.message.caption || "";
  const url = extractSupportedUrl(text);
  if (!url) return;

  // Получаем среднее время обработки
  const avgTime = getAverageProcessingTime();
  const avgTimeSeconds = Math.round(avgTime / 1000);

  const message =
    avgTime > 0
      ? `Обрабатываю ссылку…\nСреднее время ожидания: ${avgTimeSeconds}с 😉`
      : "Обрабатываю ссылку…";

  const ack = await ctx.reply(message, {
    reply_to_message_id: ctx.message.message_id,
    allow_sending_without_reply: true,
  });

  await queue.add(
    "download",
    {
      chatId: ctx.chat.id,
      messageId: ctx.message.message_id,
      ackMessageId: ack.message_id,
      url,
      sizeLimitMB,
    },
    {
      removeOnComplete: 500,
      removeOnFail: 500,
      attempts: 3,
      backoff: { type: "exponential", delay: 5000 },
      jobId: `${ctx.chat.id}:${ctx.message.message_id}`, // грубая дедупликация
    }
  );
});

bot.catch((err: any) => {
  const ctx = err.ctx;
  if (err.error instanceof GrammyError) {
    console.error("Telegram API error:", err.error.description);
  } else if (err.error instanceof HttpError) {
    console.error("HTTP error:", err.error);
  } else {
    console.error("Unknown error:", err.error);
  }
});

// === Дашборд ===
const fastify = Fastify({ logger: true });

async function startServer() {
  // Эндпоинты без авторизации
  fastify.get("/health", async () => ({ ok: true }));

  // Эндпоинт для записи статистики от воркера (без авторизации)
  fastify.post("/stats", async (request: any, reply: any) => {
    const { ts, url, status, bytes, duration_ms, chat_id } =
      request.body as any;

    const stmt = db.prepare(`
      INSERT INTO jobs (ts, url, chat_id, status, bytes, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(ts, url, chat_id, status, bytes, duration_ms);

    return { ok: true };
  });

  // Эндпоинт для получения статистики (без авторизации)
  fastify.get("/api/stats", async (request: any, reply: any) => {
    const now = Date.now();
    const day = now - 24 * 3600 * 1000;
    const week = now - 7 * 24 * 3600 * 1000;
    const month = now - 30 * 24 * 3600 * 1000;

    const q = db.prepare(`SELECT
      SUM(CASE WHEN ts>=? THEN 1 ELSE 0 END) as d_total,
      SUM(CASE WHEN ts>=? THEN 1 ELSE 0 END) as w_total,
      SUM(CASE WHEN ts>=? THEN 1 ELSE 0 END) as m_total,
      COUNT(*) as all_total,
      SUM(bytes) as all_bytes,
      AVG(duration_ms) as avg_ms
    FROM jobs`);
    const row = q.get(day, week, month);

    const proxyEnabled = !!(
      process.env.HTTP_PROXY ||
      process.env.HTTPS_PROXY ||
      process.env.ALL_PROXY
    );
    const proxyUrl =
      process.env.HTTPS_PROXY ||
      process.env.HTTP_PROXY ||
      process.env.ALL_PROXY ||
      "не настроен";

    return {
      daily: row.d_total ?? 0,
      weekly: row.w_total ?? 0,
      monthly: row.m_total ?? 0,
      total: row.all_total ?? 0,
      traffic: Math.round(((row.all_bytes ?? 0) / 1024 / 1024) * 10) / 10,
      avgDuration: Math.round(row.avg_ms ?? 0),
      proxyEnabled,
      proxyUrl: proxyEnabled ? proxyUrl : null,
    };
  });

  // Эндпоинт для получения данных графиков (без авторизации)
  fastify.get("/api/charts", async (request: any, reply: any) => {
    const now = Date.now();
    const last24h = now - 24 * 3600 * 1000;
    const last7d = now - 7 * 24 * 3600 * 1000;

    // График активности за последние 24 часа (по часам)
    const hourlyQuery = db.prepare(`
      SELECT
        strftime('%H', ts/1000, 'unixepoch') as hour,
        COUNT(*) as count
      FROM jobs
      WHERE ts >= ?
      GROUP BY strftime('%H', ts/1000, 'unixepoch')
      ORDER BY hour
    `);
    const hourlyData = hourlyQuery.all(last24h);

    // График активности за последние 7 дней (по дням)
    const dailyQuery = db.prepare(`
      SELECT
        strftime('%Y-%m-%d', ts/1000, 'unixepoch') as date,
        COUNT(*) as count,
        AVG(duration_ms) as avg_duration
      FROM jobs
      WHERE ts >= ?
      GROUP BY strftime('%Y-%m-%d', ts/1000, 'unixepoch')
      ORDER BY date
    `);
    const dailyData = dailyQuery.all(last7d);

    return {
      hourly: hourlyData,
      daily: dailyData,
    };
  });

  // Защищенные эндпоинты с авторизацией
  await fastify.register(async function (fastify) {
    await fastify.register(fastifyBasicAuth, {
      validate: async (username: any, password: any) => {
        const [u, p] = (
          process.env.DASHBOARD_BASIC_AUTH ?? "admin:admin"
        ).split(":");
        if (username !== u || password !== p) {
          throw new Error("Auth failed");
        }
      },
      authenticate: true,
    });

    fastify.after(() => {
      fastify.addHook("onRequest", fastify.basicAuth);
    });

    fastify.get("/dashboard", async (req: any, reply: any) => {
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
  }); // Закрываем регистрацию защищенных эндпоинтов

  // Запуск сервера
  fastify.listen({ port: 3000, host: "0.0.0.0" }, (err: any, address: any) => {
    if (err) {
      console.error("Error starting server:", err);
      process.exit(1);
    }
    console.log(`🚀 Dashboard server listening at ${address}`);
  });
}

// Запуск сервера и бота
startServer();

// Добавляем обработчики ошибок
bot.catch((err) => {
  console.error("❌ Bot error:", err);
});

// Проверяем подключение к Telegram API
bot.api
  .getMe()
  .then((me) => {
    console.log(
      `✅ Bot connected successfully: @${me.username} (${me.first_name})`
    );
  })
  .catch((error) => {
    console.error("❌ Failed to connect to Telegram API:", error);
    console.error("Error details:", {
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
    });
    process.exit(1);
  });

// Запуск бота
try {
  bot.start();
  console.log("🤖 Bot polling started successfully");
} catch (error) {
  console.error("❌ Bot failed to start:", error);
  process.exit(1);
}
