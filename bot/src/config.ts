export const token = process.env.BOT_TOKEN!;
export const sizeLimitMB = Number(process.env.SIZE_LIMIT_MB ?? "50");
export const adminChatId = process.env.ADMIN_CHAT_ID
  ? Number(process.env.ADMIN_CHAT_ID)
  : null;

export const redisUrl = process.env.REDIS_URL!;
export const queueName = process.env.QUEUE_NAME || "tiktok";

export const AVG_TIME_CACHE_TTL_MS = 60_000;
export const API_CACHE_TTL_MS = 10_000;
export const TG_CHAT_CACHE_TTL = 24 * 3600;
export const TG_AVATAR_CACHE_TTL = 6 * 3600;
export const TG_API_DELAY_MS = 50;
