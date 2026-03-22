import { Bot, GrammyError, HttpError } from "grammy";
import Fastify from "fastify";
import fastifyBasicAuth from "@fastify/basic-auth";
import { Queue } from "bullmq";
import IORedis from "ioredis";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { readFileSync, createReadStream } from "node:fs";
import { join } from "node:path";

import { token, sizeLimitMB, adminChatId, redisUrl, queueName, AVG_TIME_CACHE_TTL_MS, API_CACHE_TTL_MS, TG_CHAT_CACHE_TTL, TG_AVATAR_CACHE_TTL, TG_API_DELAY_MS, JOBS_RETENTION_DAYS, JOBS_PURGE_INTERVAL_HOURS } from "./config";
import type { StatsBody } from "./types";
import { initDB, pool, startJobsRetentionSchedule } from "./db";
import { extractSupportedUrls } from "./urls";
import { handleAdminCommand, isAdmin } from "./admin";
import {
  probeCacheForUrl,
  resolveCacheKeyForUrl,
  getCachedVideoPathForKey,
  getImageFilePath,
} from "./cacheFs";

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
const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue(queueName, { connection });

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
    const value = Math.round(Number(rows[0]?.avg) ?? 0);
    avgTimeCache = { value, expiresAt: Date.now() + AVG_TIME_CACHE_TTL_MS };
    return value;
  } catch {
    return 0;
  }
}

bot.on("message:text", async (ctx) => {
  const text = (ctx.message.text || ctx.message.caption || "").trim();

  if (text === "/start") {
    await ctx.reply(
      isAdmin(ctx.chat.id)
        ? "🟢 Ты админ! Команды: /help"
        : "👋 Привет! Отправь ссылку на TikTok, YouTube Shorts, VK Clips или Instagram (Reels/посты)."
    );
    return;
  }

  if (await handleAdminCommand(ctx, queue)) return;

  const extractedList = extractSupportedUrls(text);
  if (extractedList.length === 0) return;

  const userId = ctx.message.from?.id ?? ctx.chat.id;
  const RATE_LIMIT = Number(process.env.RATE_LIMIT_PER_MINUTE || "10");
  if (!isAdmin(ctx.chat.id) && RATE_LIMIT > 0) {
    const rateKey = `ratelimit:${userId}`;
    const count = await connection.incr(rateKey);
    if (count === 1) await connection.pexpire(rateKey, 60_000);
    if (count > RATE_LIMIT) {
      await ctx.reply(
        `⏳ Слишком много запросов. Лимит: ${RATE_LIMIT} в минуту. Подождите немного.`,
        { reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true } }
      );
      return;
    }
  }

  const jobs = await queue.getJobs(["waiting", "active"]);
  const urlsInQueue = new Set(
    jobs.map((j) => (j.data as { url?: string })?.url).filter(Boolean)
  );

  const toAdd = extractedList.filter((e) => !urlsInQueue.has(e.url));
  const duplicates = extractedList.length - toAdd.length;

  if (toAdd.length === 0) {
    await ctx.reply("⏳ Эта ссылка уже в очереди.", {
      reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
    });
    return;
  }

  const avgTime = await getAverageProcessingTime();
  const avgTimeSeconds = Math.round(avgTime / 1000);
  const from = ctx.message.from;

  for (let i = 0; i < toAdd.length; i++) {
    const extracted = toAdd[i];
    const total = toAdd.length;
    const msg =
      total > 1
        ? `Обрабатываю ссылку ${i + 1}/${total}…`
        : avgTime > 0
          ? `Обрабатываю ссылку…\nСреднее время: ${avgTimeSeconds}с 😉`
          : "Обрабатываю ссылку…";

    const ack = await ctx.reply(msg, {
      reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
    });

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
        jobId: `${ctx.chat.id}:${ctx.message.message_id}:${i}`,
      }
    );
  }

  if (duplicates > 0) {
    await ctx.reply(`ℹ️ ${duplicates} ссылок уже в очереди, добавлено ${toAdd.length}.`, {
      reply_parameters: { message_id: ctx.message.message_id, allow_sending_without_reply: true },
    });
  }
});

bot.catch((err: { error: unknown }) => {
  if (err.error instanceof GrammyError) {
    console.error("Telegram API error:", err.error.description);
  } else if (err.error instanceof HttpError) {
    console.error("HTTP error:", err.error);
  } else {
    console.error("Unknown error:", err.error);
  }
});

const fastify = Fastify({ logger: true });

let tgLastCall = 0;

async function tgRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - tgLastCall;
  if (elapsed < TG_API_DELAY_MS) {
    await new Promise((r) => setTimeout(r, TG_API_DELAY_MS - elapsed));
  }
  tgLastCall = Date.now();
}

async function getCachedChat(chatId: number): Promise<{ title?: string; type?: string; username?: string } | null> {
  const key = `tg:chat:${chatId}`;
  try {
    const cached = await connection.get(key);
    if (cached) return JSON.parse(cached);
  } catch (e) {
    console.warn("Redis chat cache read failed:", e);
  }
  try {
    await tgRateLimit();
    const chat = await bot.api.getChat(chatId);
    const data = {
      title: "title" in chat ? chat.title : undefined,
      type: chat.type,
      username: "username" in chat ? chat.username : undefined,
    };
    await connection.setex(key, TG_CHAT_CACHE_TTL, JSON.stringify(data));
    return data;
  } catch (e: unknown) {
    const err = e as { description?: string };
    if (err?.description?.includes("chat not found")) return null;
    console.warn(`getChat(${chatId}) failed:`, err?.description || e);
    return null;
  }
}

async function getCachedAvatarPath(userId: number): Promise<string | null> {
  const key = `tg:avatar:${userId}`;
  try {
    const cached = await connection.get(key);
    if (cached) return cached === "__none__" ? null : cached;
  } catch (e) {
    console.warn("Redis avatar cache read failed:", e);
  }
  try {
    await tgRateLimit();
    const photos = await bot.api.getUserProfilePhotos(userId, { limit: 1 });
    if (!photos.total_count || !photos.photos[0]?.[0]) {
      await connection.setex(key, TG_AVATAR_CACHE_TTL, "__none__");
      return null;
    }
    const fileId = photos.photos[0][0].file_id;
    await tgRateLimit();
    const file = await bot.api.getFile(fileId);
    const path = file.file_path;
    if (path) {
      await connection.setex(key, TG_AVATAR_CACHE_TTL, path);
      return path;
    }
  } catch (e: unknown) {
    const err = e as { description?: string };
    console.warn(`getUserProfilePhotos(${userId}) failed:`, err?.description || e);
  }
  return null;
}

async function startServer() {
  fastify.get("/health", async () => ({ ok: true }));

  const statsBodySchema = {
    type: "object",
    required: ["ts", "url", "status", "bytes", "duration_ms", "chat_id"],
    properties: {
      ts: { type: "integer", minimum: 0 },
      url: { type: "string", maxLength: 2048 },
      status: {
        type: "string",
        enum: ["success", "failed", "cached", "compressed", "too_large"],
      },
      bytes: { type: "integer", minimum: 0 },
      duration_ms: { type: "integer", minimum: 0 },
      chat_id: { type: "integer" },
      user_id: { type: ["integer", "null"] },
      username: { type: ["string", "null"], maxLength: 256 },
      first_name: { type: ["string", "null"], maxLength: 256 },
      platform: { type: ["string", "null"], maxLength: 64 },
      error_message: { type: ["string", "null"], maxLength: 1000 },
    },
    additionalProperties: false,
  };

  fastify.post(
    "/stats",
    { schema: { body: statsBodySchema } },
    async (request) => {
      const body = request.body as StatsBody;
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
      } = body;

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
    }
  );

  const API_CACHE_TTL_MS = 10_000;
  const apiCache = new Map<string, { data: unknown; expiresAt: number }>();

  function getCached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const cached = apiCache.get(key);
    if (cached && Date.now() < cached.expiresAt)
      return Promise.resolve(cached.data as T);
    return fetcher().then((data) => {
      apiCache.set(key, { data, expiresAt: Date.now() + API_CACHE_TTL_MS });
      return data;
    });
  }

  fastify.get("/api/queue", async () => {
    const [waiting, active, delayed, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getDelayedCount(),
      queue.getFailedCount(),
    ]);
    return { waiting, active, delayed, failed };
  });

  fastify.get("/api/chat/:chatId", async (request: any, reply: any) => {
    const chatId = Number((request as any).params.chatId);
    if (!chatId) return reply.status(400).send({ error: "Invalid chatId" });
    const chat = await getCachedChat(chatId);
    return chat || { error: "Chat not found" };
  });

  fastify.get("/api/avatar/:userId", async (request: any, reply: any) => {
    const userId = Number((request as any).params.userId);
    if (!userId) return reply.status(400).send({ error: "Invalid userId" });
    const path = await getCachedAvatarPath(userId);
    if (!path) return reply.status(404).send({ error: "Avatar not found" });
    const url = `https://api.telegram.org/file/bot${token}/${path}`;
    try {
      const res = await fetch(url);
      if (!res.ok) return reply.status(502).send({ error: "Telegram fetch failed" });
      const contentType = res.headers.get("content-type") || "image/jpeg";
      return reply.type(contentType).send(res.body);
    } catch (e) {
      return reply.status(502).send({ error: "Proxy failed" });
    }
  });

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
        COUNT(*) FILTER (WHERE status = 'cached')     AS total_cached,
        COUNT(*) FILTER (WHERE status = 'failed')     AS total_failed,
        COUNT(*) FILTER (WHERE status = 'compressed') AS total_compressed,
        COUNT(*) FILTER (WHERE status = 'too_large')  AS total_too_large,
        COUNT(DISTINCT chat_id)                        AS unique_chats,
        COUNT(DISTINCT user_id) FILTER (WHERE user_id IS NOT NULL) AS unique_users
      FROM jobs
    `,
        [now - 86400_000, now - 7 * 86400_000, now - 30 * 86400_000]
      );

      const trafficByPlatformQ = await pool.query(
        `SELECT platform, COALESCE(SUM(bytes), 0) AS total_bytes
         FROM jobs WHERE ts >= $1 AND platform IS NOT NULL
         GROUP BY platform ORDER BY total_bytes DESC`,
        [now - 30 * 86400_000]
      );

      const avgByPlatformQ = await pool.query(
        `SELECT platform, AVG(duration_ms) FILTER (WHERE duration_ms > 0) AS avg_ms
         FROM jobs WHERE ts >= $1 AND platform IS NOT NULL
         GROUP BY platform`,
        [now - 30 * 86400_000]
      );

      const topUsersQ = await pool.query(
        `SELECT user_id, MAX(first_name) AS name, MAX(username) AS username, COUNT(*) AS cnt, COALESCE(SUM(bytes), 0) AS total_bytes
         FROM jobs WHERE user_id IS NOT NULL
         GROUP BY user_id ORDER BY cnt DESC LIMIT 5`
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
        totalCached: Number(r.total_cached),
        totalFailed: Number(r.total_failed),
        totalCompressed: Number(r.total_compressed),
        totalTooLarge: Number(r.total_too_large),
        uniqueChats: Number(r.unique_chats),
        uniqueUsers: Number(r.unique_users),
        proxyEnabled,
        trafficByPlatform: trafficByPlatformQ.rows.map((p: any) => ({
          platform: p.platform,
          bytes: Number(p.total_bytes),
          mb: Math.round((Number(p.total_bytes) / 1024 / 1024) * 10) / 10,
        })),
        avgByPlatform: avgByPlatformQ.rows.map((p: any) => ({
          platform: p.platform,
          avgMs: Math.round(Number(p.avg_ms) || 0),
        })),
        topUsers: topUsersQ.rows.map((u: any) => ({
          userId: u.user_id,
          name: u.name || u.username || String(u.user_id),
          username: u.username,
          count: Number(u.cnt),
          bytes: Number(u.total_bytes),
          profileUrl: u.username
            ? `https://t.me/${u.username}`
            : `https://t.me/id${u.user_id}`,
          avatarUrl: `/api/avatar/${u.user_id}`,
        })),
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

  async function buildRecentItems(request: any): Promise<{
    total: number;
    items: any[];
  }> {
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

    const rows = dataQ.rows as any[];
    const chatIds = [...new Set(rows.map((r) => Number(r.chat_id)).filter(Boolean))];
    const chatCache: Record<string, { title?: string; type?: string; username?: string }> = {};
    for (const cid of chatIds) {
      const chat = await getCachedChat(cid);
      if (chat) chatCache[String(cid)] = chat;
    }

    const items = rows.map((r) => {
      const chatId = Number(r.chat_id);
      const chat = chatCache[String(chatId)];
      const chatTitle = chat?.title || (chatId < 0 ? `Чат ${chatId}` : null);
      const chatType = chat?.type;
      const chatUrl = chat?.username ? `https://t.me/${chat.username}` : null;
      const userProfileUrl =
        r.username ? `https://t.me/${r.username}` : r.user_id ? `https://t.me/id${r.user_id}` : null;
      return {
        ...r,
        chatTitle,
        chatType,
        chatUrl,
        userProfileUrl,
      };
    });

    return {
      total: Number(countQ.rows[0].total),
      items,
    };
  }

  fastify.get("/api/recent", async (request: any) => {
    return buildRecentItems(request);
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

    fastify.get("/api/admin/recent", async (request: any) => {
      const data = await buildRecentItems(request);
      const items = await Promise.all(
        data.items.map(async (item: { url: string }) => {
          const probe = await probeCacheForUrl(item.url, connection);
          return {
            ...item,
            cachePreview: {
              available: probe.kind !== null,
              kind: probe.kind,
              imageCount: probe.imageCount,
            },
          };
        })
      );
      return { ...data, items };
    });

    fastify.get(
      "/api/admin/cache/:jobId/video",
      async (request: any, reply: any) => {
        const jobId = Number((request as any).params.jobId);
        if (!Number.isFinite(jobId) || jobId < 1) {
          return reply.status(400).send({ error: "Invalid job id" });
        }
        const { rows } = await pool.query(
          "SELECT url FROM jobs WHERE id = $1",
          [jobId]
        );
        if (!rows.length) {
          return reply.status(404).send({ error: "Job not found" });
        }
        const url = String((rows[0] as { url: string }).url);
        const key = await resolveCacheKeyForUrl(url, connection);
        if (!key) {
          return reply.status(404).send({ error: "Not in cache" });
        }
        const p = getCachedVideoPathForKey(key);
        if (!p) {
          return reply.status(404).send({ error: "No video in cache" });
        }
        return reply.type("video/mp4").send(createReadStream(p));
      }
    );

    fastify.get(
      "/api/admin/cache/:jobId/image/:index",
      async (request: any, reply: any) => {
        const jobId = Number((request as any).params.jobId);
        const index = Number((request as any).params.index);
        if (!Number.isFinite(jobId) || jobId < 1) {
          return reply.status(400).send({ error: "Invalid job id" });
        }
        if (!Number.isInteger(index) || index < 0) {
          return reply.status(400).send({ error: "Invalid index" });
        }
        const { rows } = await pool.query(
          "SELECT url FROM jobs WHERE id = $1",
          [jobId]
        );
        if (!rows.length) {
          return reply.status(404).send({ error: "Job not found" });
        }
        const url = String((rows[0] as { url: string }).url);
        const key = await resolveCacheKeyForUrl(url, connection);
        if (!key) {
          return reply.status(404).send({ error: "Not in cache" });
        }
        const p = getImageFilePath(key, index);
        if (!p) {
          return reply.status(404).send({ error: "Image not in cache" });
        }
        return reply.type("image/jpeg").send(createReadStream(p));
      }
    );
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
  startJobsRetentionSchedule(JOBS_RETENTION_DAYS, JOBS_PURGE_INTERVAL_HOURS);
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
