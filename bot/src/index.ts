import { Bot, GrammyError, HttpError } from "grammy";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { Queue, QueueEvents } from "bullmq";
import IORedis from "ioredis";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { readFileSync, createReadStream, existsSync } from "node:fs";
import { join } from "node:path";

/** 1×1 прозрачный GIF — favicon и прочие места, где нужен «пустой» пиксель. */
const AVATAR_PLACEHOLDER_GIF = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
const DASHBOARD_FONT_FILES = new Set([
  "ibm-plex-sans-cyrillic-ext.woff2",
  "ibm-plex-sans-cyrillic.woff2",
  "ibm-plex-sans-latin-ext.woff2",
  "ibm-plex-sans-latin.woff2",
]);

/** Видимая заглушка для `/api/avatar` (прозрачный GIF ломал UX: img грузился «успешно», onerror не вызывался). */
const AVATAR_PLACEHOLDER_SVG = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64" aria-hidden="true">
  <defs>
    <linearGradient id="avph" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#232d45"/>
      <stop offset="100%" stop-color="#1a2035"/>
    </linearGradient>
  </defs>
  <circle cx="32" cy="32" r="32" fill="url(#avph)"/>
  <circle cx="32" cy="24" r="9" fill="#64748b" opacity="0.95"/>
  <ellipse cx="32" cy="47" rx="14" ry="11" fill="#64748b" opacity="0.9"/>
</svg>`,
  "utf-8",
);

function resolveChartBundlePath(): string | null {
  const vendor = join(__dirname, "..", "vendor", "chart.umd.js");
  if (existsSync(vendor)) return vendor;
  const fromModules = join(
    __dirname,
    "..",
    "node_modules",
    "chart.js",
    "dist",
    "chart.umd.js",
  );
  if (existsSync(fromModules)) return fromModules;
  return null;
}

import {
  token,
  statsInternalToken,
  sizeLimitMB,
  adminChatId,
  redisUrl,
  queueName,
  AVG_TIME_CACHE_TTL_MS,
  API_CACHE_TTL_MS,
  TG_CHAT_CACHE_TTL,
  TG_AVATAR_CACHE_TTL,
  TG_API_DELAY_MS,
  JOBS_RETENTION_DAYS,
  JOBS_PURGE_INTERVAL_HOURS,
} from "./config";
import {
  timingSafeEqualUtf8,
  toContainsLikePattern,
} from "./utils";
import type { StatsBody } from "./types";
import { initDB, pool, startJobsRetentionSchedule } from "./db";
import { insertStat } from "./stats";
import { extractSupportedUrls } from "./urls";
import { handleAdminCommand, isAdmin } from "./admin";
import {
  probeCacheForUrl,
  resolveCacheKeyForUrl,
  getCachedVideoPathForKey,
  getImageFilePath,
} from "./cacheFs";
import { rehydrateCacheMappingForJobUrl } from "./cacheRehydrate";
import { DashboardEventBus } from "./dashboardEvents";
import { registerDashboardAuth } from "./dashboardAuth";
import { redisStorageError } from "./queueHealth";

console.log("🔧 Environment variables:");
console.log(`  BOT_TOKEN: ${token ? "SET" : "NOT SET"}`);
console.log(`  DATABASE_URL: ${process.env.DATABASE_URL ? "SET" : "NOT SET"}`);
console.log(`  ADMIN_CHAT_ID: ${adminChatId ?? "NOT SET"}`);
console.log(
  `  POST /stats: ${
    process.env.STATS_INTERNAL_TOKEN?.trim()
      ? "секрет из STATS_INTERNAL_TOKEN"
      : "секрет выведен из BOT_TOKEN"
  }`,
);
console.log(`  HTTP_PROXY: ${process.env.HTTP_PROXY ? "SET" : "NOT SET"}`);
console.log(`  HTTPS_PROXY: ${process.env.HTTPS_PROXY ? "SET" : "NOT SET"}`);

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
      [since],
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
        : "👋 Привет! Отправь ссылку на TikTok, YouTube Shorts, VK Clips, Instagram (Reels/посты) или X/Twitter (пост со статусом).",
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
        {
          reply_parameters: {
            message_id: ctx.message.message_id,
            allow_sending_without_reply: true,
          },
        },
      );
      return;
    }
  }

  const jobs = await queue.getJobs(["waiting", "active"]);
  const urlsInQueue = new Set(
    jobs
      .map((j) => {
        const d = j.data as { url?: string; chatId?: number };
        if (!d?.url || d.chatId == null) return null;
        return `${d.chatId}:${d.url}`;
      })
      .filter((k): k is string => k !== null),
  );

  const toAdd = extractedList.filter(
    (e) => !urlsInQueue.has(`${ctx.chat.id}:${e.url}`),
  );
  const duplicates = extractedList.length - toAdd.length;

  if (toAdd.length === 0) {
    await ctx.reply("⏳ Эта ссылка уже в очереди.", {
      reply_parameters: {
        message_id: ctx.message.message_id,
        allow_sending_without_reply: true,
      },
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
      reply_parameters: {
        message_id: ctx.message.message_id,
        allow_sending_without_reply: true,
      },
    });

    await queue.add(
      "download",
      {
        chatId: ctx.chat.id,
        messageId: ctx.message.message_id,
        messageThreadId: ctx.message.message_thread_id,
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
      },
    );
  }

  if (duplicates > 0) {
    await ctx.reply(
      `ℹ️ ${duplicates} ссылок уже в очереди, добавлено ${toAdd.length}.`,
      {
        reply_parameters: {
          message_id: ctx.message.message_id,
          allow_sending_without_reply: true,
        },
      },
    );
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

async function assertStatsInternalAuth(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(\S+)/i)?.[1];
  const headerToken =
    (typeof request.headers["x-stats-token"] === "string"
      ? request.headers["x-stats-token"]
      : undefined) ?? bearer;
  if (!timingSafeEqualUtf8(headerToken ?? "", statsInternalToken)) {
    await reply.status(401).send({ error: "Unauthorized" });
    return;
  }
}

let tgLastCall = 0;

async function tgRateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - tgLastCall;
  if (elapsed < TG_API_DELAY_MS) {
    await new Promise((r) => setTimeout(r, TG_API_DELAY_MS - elapsed));
  }
  tgLastCall = Date.now();
}

async function getCachedChat(
  chatId: number,
): Promise<{ title?: string; type?: string; username?: string } | null> {
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
    /** До 10 снимков: при сбое file_path у одного пробуем следующий (редко, но бывает). */
    const photos = await bot.api.getUserProfilePhotos(userId, { limit: 10 });
    if (!photos.total_count || !photos.photos?.length) {
      await connection.setex(key, TG_AVATAR_CACHE_TTL, "__none__");
      return null;
    }
    for (const variantRow of photos.photos) {
      if (!variantRow?.length) continue;
      const largest = variantRow[variantRow.length - 1];
      const fileId = largest.file_id;
      await tgRateLimit();
      const file = await bot.api.getFile(fileId);
      const path = file.file_path;
      if (path) {
        await connection.setex(key, TG_AVATAR_CACHE_TTL, path);
        return path;
      }
    }
    await connection.setex(key, TG_AVATAR_CACHE_TTL, "__none__");
    return null;
  } catch (e: unknown) {
    const g = e instanceof GrammyError ? e : null;
    const desc = g?.description ?? String(e);
    if (
      g?.error_code === 400 ||
      /PEER_ID_INVALID|user not found|USER_NOT_FOUND|user_id_invalid/i.test(
        desc,
      )
    ) {
      try {
        await connection.setex(
          key,
          Math.min(TG_AVATAR_CACHE_TTL, 3600),
          "__none__",
        );
      } catch {
        /* ignore */
      }
      return null;
    }
    console.warn(
      `getUserProfilePhotos(${userId}) failed:`,
      g?.description || e,
    );
  }
  return null;
}

async function startServer() {
  const dashboardEvents = new DashboardEventBus();
  const queueEvents = new QueueEvents(queueName, {
    connection: connection.duplicate(),
  });
  queueEvents.on("error", (error) => {
    fastify.log.warn({ error }, "Dashboard queue event stream disconnected");
  });
  const queueEventNames = [
    "active", "waiting", "completed", "failed", "stalled", "progress", "delayed",
  ] as const;
  for (const eventName of queueEventNames) {
    queueEvents.on(eventName, () => dashboardEvents.publish(["queue"]));
  }
  void queueEvents.waitUntilReady().catch((error) => {
    fastify.log.warn({ error }, "Dashboard queue event stream is not ready");
  });

  let lastStorageError: string | null = null;
  let checkingStorage = false;
  const heartbeat = setInterval(() => {
    dashboardEvents.heartbeat();
    if (checkingStorage) return;
    checkingStorage = true;
    void connection.info("persistence").then((info) => {
      const storageError = redisStorageError(info);
      if (storageError !== lastStorageError) {
        lastStorageError = storageError;
        dashboardEvents.publish(["queue"]);
      }
    }).catch((error) => {
      fastify.log.warn({ error }, "Dashboard queue storage check failed");
    }).finally(() => { checkingStorage = false; });
  }, 20000);
  heartbeat.unref();
  fastify.addHook("onClose", async () => {
    clearInterval(heartbeat);
    dashboardEvents.close();
    await queueEvents.close();
  });

  fastify.get("/health", async () => ({ ok: true }));

  fastify.get("/favicon.ico", async (_req, reply) =>
    reply
      .header("Cache-Control", "public, max-age=86400")
      .type("image/gif")
      .send(AVATAR_PLACEHOLDER_GIF),
  );

  fastify.get("/vendor/chart.umd.js", async (_req, reply) => {
    const chartPath = resolveChartBundlePath();
    if (!chartPath) {
      console.error(
        "Chart.js не найден: vendor/chart.umd.js или npm i chart.js (dev)",
      );
      return reply
        .status(503)
        .type("application/javascript; charset=utf-8")
        .send("console.error('Chart.js bundle missing');\n");
    }
    return reply
      .header("Cache-Control", "public, max-age=86400")
      .type("application/javascript; charset=utf-8")
      .send(createReadStream(chartPath));
  });

  fastify.get("/assets/dashboard.css", async (_req, reply) => {
    const p = join(__dirname, "..", "assets", "dashboard.css");
    if (!existsSync(p)) {
      return reply.status(404).send("Not found");
    }
    return reply
      .header("Cache-Control", "public, max-age=86400")
      .type("text/css; charset=utf-8")
      .send(createReadStream(p));
  });

  fastify.get("/assets/dashboard.js", async (_req, reply) => {
    const p = join(__dirname, "..", "assets", "dashboard.js");
    if (!existsSync(p)) {
      return reply.status(404).send("Not found");
    }
    return reply
      .header("Cache-Control", "public, max-age=86400")
      .type("application/javascript; charset=utf-8")
      .send(createReadStream(p));
  });

  fastify.get("/assets/fonts/:font", async (request: any, reply) => {
    const name = String(request.params.font || "");
    if (!DASHBOARD_FONT_FILES.has(name)) return reply.status(404).send("Not found");
    const p = join(__dirname, "..", "assets", "fonts", name);
    if (!existsSync(p)) return reply.status(404).send("Not found");
    return reply
      .header("Cache-Control", "public, max-age=31536000, immutable")
      .type("font/woff2")
      .send(createReadStream(p));
  });

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
      source_message_id: { type: ["integer", "null"] },
      source_thread_id: { type: ["integer", "null"] },
      user_id: { type: ["integer", "null"] },
      username: { type: ["string", "null"], maxLength: 256 },
      first_name: { type: ["string", "null"], maxLength: 256 },
      platform: { type: ["string", "null"], maxLength: 64 },
      event_id: { type: "string", maxLength: 64 },
      error_message: { type: ["string", "null"], maxLength: 1000 },
    },
    additionalProperties: false,
  };

  const apiCache = new Map<string, { data: unknown; expiresAt: number }>();

  fastify.post(
    "/stats",
    {
      preHandler: assertStatsInternalAuth,
      schema: { body: statsBodySchema },
    },
    async (request) => {
      const body = request.body as StatsBody;
      await insertStat(body);
      apiCache.delete("stats");
      apiCache.delete("charts");
      dashboardEvents.publish(["stats", "charts", "recent"]);

      return { ok: true };
    },
  );

  function getCached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const cached = apiCache.get(key);
    if (cached && Date.now() < cached.expiresAt)
      return Promise.resolve(cached.data as T);
    return fetcher().then((data) => {
      apiCache.set(key, { data, expiresAt: Date.now() + API_CACHE_TTL_MS });
      return data;
    });
  }

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
      q,
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
    if (typeof q === "string" && q.trim()) {
      where += ` AND (url ILIKE $${idx} ESCAPE '!' OR COALESCE(username, '') ILIKE $${idx} ESCAPE '!' OR COALESCE(first_name, '') ILIKE $${idx} ESCAPE '!' OR chat_id::text ILIKE $${idx} ESCAPE '!' OR user_id::text ILIKE $${idx} ESCAPE '!' OR id::text ILIKE $${idx} ESCAPE '!' OR COALESCE(error_message, '') ILIKE $${idx} ESCAPE '!')`;
      params.push(toContainsLikePattern(q));
      idx++;
    }

    const countQ = await pool.query(
      `SELECT COUNT(*) AS total FROM jobs ${where}`,
      params,
    );

    const dataQ = await pool.query(
      `SELECT id, ts, url, chat_id, source_message_id, source_thread_id, user_id, username, first_name, platform, status, bytes, duration_ms, error_message
       FROM jobs ${where}
       ORDER BY ts DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, Math.min(Number(limit), 200), Number(offset)],
    );

    const rows = dataQ.rows as any[];
    const chatIds = [
      ...new Set(rows.map((r) => Number(r.chat_id)).filter(Boolean)),
    ];
    const chatCache: Record<
      string,
      { title?: string; type?: string; username?: string }
    > = {};
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
      const userProfileUrl = r.username
        ? `https://t.me/${r.username}`
        : r.user_id
          ? `https://t.me/id${r.user_id}`
          : null;
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

  await fastify.register(async function (secured) {
    await registerDashboardAuth(secured);

    secured.get("/api/queue", async () => {
      const [waiting, active, delayed, failed, persistenceInfo] = await Promise.all([
        queue.getWaitingCount(),
        queue.getActiveCount(),
        queue.getDelayedCount(),
        queue.getFailedCount(),
        connection.info("persistence"),
      ]);
      return { waiting, active, delayed, failed, storageError: redisStorageError(persistenceInfo) };
    });

    secured.get("/api/admin/events", async (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      reply.raw.write("retry: 3000\nevent: connected\ndata: {}\n\n");
      const unsubscribe = dashboardEvents.subscribe(reply.raw);
      reply.raw.on("close", unsubscribe);
      request.raw.on("aborted", unsubscribe);
    });

    secured.get("/api/chat/:chatId", async (request: any, reply: any) => {
      const chatId = Number((request as any).params.chatId);
      if (!chatId) return reply.status(400).send({ error: "Invalid chatId" });
      const chat = await getCachedChat(chatId);
      return chat || { error: "Chat not found" };
    });

    secured.get("/api/avatar/:userId", async (request: any, reply: any) => {
      const userId = Number((request as any).params.userId);
      if (!userId) return reply.status(400).send({ error: "Invalid userId" });
      const avatarKey = `tg:avatar:${userId}`;
      const sendPlaceholder = () =>
        reply
          .header("Cache-Control", "public, max-age=86400")
          .type("image/svg+xml; charset=utf-8")
          .send(AVATAR_PLACEHOLDER_SVG);
      const path = await getCachedAvatarPath(userId);
      if (!path) return sendPlaceholder();
      const url = `https://api.telegram.org/file/bot${token}/${path}`;
      try {
        const res = await fetch(url);
        if (!res.ok) {
          await connection.del(avatarKey).catch(() => {});
          return sendPlaceholder();
        }
        const contentType = res.headers.get("content-type") || "image/jpeg";
        return reply
          .header("Cache-Control", "public, max-age=300")
          .type(contentType)
          .send(res.body);
      } catch {
        await connection.del(avatarKey).catch(() => {});
        return sendPlaceholder();
      }
    });

    secured.get("/api/stats", async (request: any) => {
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
          [now - 86400_000, now - 7 * 86400_000, now - 30 * 86400_000],
        );

        const trafficByPlatformQ = await pool.query(
          `SELECT platform, COALESCE(SUM(bytes), 0) AS total_bytes
         FROM jobs WHERE ts >= $1 AND platform IS NOT NULL
         GROUP BY platform ORDER BY total_bytes DESC`,
          [now - 30 * 86400_000],
        );

        const avgByPlatformQ = await pool.query(
          `SELECT platform, AVG(duration_ms) FILTER (WHERE duration_ms > 0) AS avg_ms
         FROM jobs WHERE ts >= $1 AND platform IS NOT NULL
         GROUP BY platform`,
          [now - 30 * 86400_000],
        );

        const topUsersQ = await pool.query(
          `SELECT user_id, MAX(first_name) AS name, MAX(username) AS username, COUNT(*) AS cnt, COALESCE(SUM(bytes), 0) AS total_bytes
         FROM jobs WHERE user_id IS NOT NULL
         GROUP BY user_id ORDER BY cnt DESC LIMIT 5`,
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

    secured.get("/api/charts", async (request: any) => {
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
          [now - 86400_000],
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
          [now - 30 * 86400_000],
        );

        const platformQ = await pool.query(
          `
      SELECT platform, COUNT(*) AS count
      FROM jobs WHERE ts >= $1 AND platform IS NOT NULL
      GROUP BY platform ORDER BY count DESC
    `,
          [now - 30 * 86400_000],
        );

        const statusQ = await pool.query(
          `
      SELECT status, COUNT(*) AS count
      FROM jobs WHERE ts >= $1
      GROUP BY status
    `,
          [now - 30 * 86400_000],
        );

        return {
          hourly: hourlyQ.rows,
          daily: dailyQ.rows,
          platforms: platformQ.rows,
          statuses: statusQ.rows,
        };
      });
    });

    secured.get("/dashboard", async (_req: any, reply: any) => {
      try {
        const html = readFileSync(
          join(__dirname, "..", "dashboard.html"),
          "utf-8",
        );
        reply.type("text/html").send(html);
      } catch (error) {
        console.error("Error reading dashboard.html:", error);
        reply.status(500).send("Error loading dashboard");
      }
    });

    secured.get("/api/admin/recent", async (request: any) => {
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
        }),
      );
      return { ...data, items };
    });

    const messageActionTarget = async (jobId: number) => {
      if (!Number.isSafeInteger(jobId) || jobId < 1) return null;
      const { rows } = await pool.query(
        "SELECT chat_id, source_message_id, source_thread_id FROM jobs WHERE id = $1",
        [jobId],
      );
      const target = rows[0] as {
        chat_id: string | number;
        source_message_id: string | number | null;
        source_thread_id: string | number | null;
      } | undefined;
      return target?.source_message_id == null ? null : target;
    };

    const requireDashboardOrigin = (request: any, reply: any): boolean => {
      const origin = request.headers.origin;
      const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "")
        .split(",")[0]
        .trim();
      const protocol = forwardedProto || request.protocol;
      let sameOrigin = false;
      try {
        sameOrigin = Boolean(origin) && new URL(origin).origin === `${protocol}://${request.headers.host}`;
      } catch {}
      if (!sameOrigin) {
        reply.status(403).send({ error: "Запрос должен прийти из админки." });
        return false;
      }
      return true;
    };

    secured.post(
      "/api/admin/jobs/:jobId/reaction",
      {
        schema: {
          body: {
            type: "object",
            required: ["emoji"],
            properties: { emoji: { type: "string", minLength: 1, maxLength: 32 } },
            additionalProperties: false,
          },
        },
      },
      async (request: any, reply: any) => {
        if (!requireDashboardOrigin(request, reply)) return;
        const jobId = Number(request.params.jobId);
        const target = await messageActionTarget(jobId);
        if (!target) return reply.status(404).send({ error: "У заявки нет сохранённого исходного сообщения." });
        const emoji = String(request.body.emoji);
        const remove = emoji === "remove";
        const isEmoji = /^[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]+$/u.test(emoji);
        if (!remove && (!isEmoji || Array.from(emoji).length > 12)) {
          return reply.status(400).send({ error: "Выбери один эмодзи реакции." });
        }
        try {
          const reaction: Parameters<typeof bot.api.setMessageReaction>[2] = remove
            ? []
            : [{ type: "emoji", emoji: emoji.replace(/\uFE0F/g, "") as any }];
          await bot.api.setMessageReaction(
            Number(target.chat_id),
            Number(target.source_message_id),
            reaction,
          );
          request.log.info({ jobId, emoji: remove ? null : emoji }, "Dashboard reaction updated");
          return reply.send({ ok: true, message: remove ? "Реакция снята." : `Реакция ${emoji} поставлена.` });
        } catch (error) {
          request.log.warn({ error, jobId }, "Telegram rejected dashboard reaction");
          return reply.status(502).send({ error: "Telegram не принял реакцию. Возможно, она запрещена в этом чате." });
        }
      },
    );

    secured.post(
      "/api/admin/jobs/:jobId/reply",
      {
        schema: {
          body: {
            type: "object",
            required: ["text"],
            properties: { text: { type: "string", minLength: 1, maxLength: 4096 } },
            additionalProperties: false,
          },
        },
      },
      async (request: any, reply: any) => {
        if (!requireDashboardOrigin(request, reply)) return;
        const jobId = Number(request.params.jobId);
        const target = await messageActionTarget(jobId);
        if (!target) return reply.status(404).send({ error: "У заявки нет сохранённого исходного сообщения." });
        const messageText = String(request.body.text).trim();
        if (!messageText || messageText.length > 4096) {
          return reply.status(400).send({ error: "Текст должен содержать от 1 до 4096 символов." });
        }
        try {
          await bot.api.sendMessage(Number(target.chat_id), messageText, {
            ...(target.source_thread_id == null
              ? {}
              : { message_thread_id: Number(target.source_thread_id) }),
            reply_parameters: {
              message_id: Number(target.source_message_id),
            },
          });
          request.log.info({ jobId }, "Dashboard reply sent");
          return reply.send({ ok: true, message: "Ответ отправлен от имени бота." });
        } catch (error) {
          request.log.warn({ error, jobId }, "Telegram rejected dashboard reply");
          return reply.status(502).send({ error: "Telegram не смог отправить сообщение. Проверь, доступен ли боту этот чат." });
        }
      },
    );

    secured.get(
      "/api/admin/cache/:jobId/video",
      async (request: any, reply: any) => {
        const jobId = Number((request as any).params.jobId);
        if (!Number.isFinite(jobId) || jobId < 1) {
          return reply.status(400).send({ error: "Invalid job id" });
        }
        const { rows } = await pool.query(
          "SELECT url FROM jobs WHERE id = $1",
          [jobId],
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
      },
    );

    secured.post(
      "/api/admin/cache/rehydrate/:jobId",
      async (request: any, reply: any) => {
        const jobId = Number((request as any).params.jobId);
        if (!Number.isFinite(jobId) || jobId < 1) {
          return reply.status(400).send({ error: "Invalid job id" });
        }
        const { rows } = await pool.query(
          "SELECT url FROM jobs WHERE id = $1",
          [jobId],
        );
        if (!rows.length) {
          return reply.status(404).send({ error: "Job not found" });
        }
        const url = String((rows[0] as { url: string }).url);
        const result = await rehydrateCacheMappingForJobUrl(url, connection);
        if (!result.ok) {
          return reply.status(404).send(result);
        }
        return reply.send(result);
      },
    );

    secured.get(
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
          [jobId],
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
      },
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
        "🟢 Бот запущен и готов к работе!\n/help — список команд",
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
