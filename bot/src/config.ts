export const token = process.env.BOT_TOKEN!;
export const sizeLimitMB = Number(process.env.SIZE_LIMIT_MB ?? "50");
export const adminChatId = process.env.ADMIN_CHAT_ID
  ? Number(process.env.ADMIN_CHAT_ID)
  : null;

export const redisUrl = process.env.REDIS_URL!;
export const queueName = process.env.QUEUE_NAME || "tiktok";

export const AVG_TIME_CACHE_TTL_MS = 60_000;
export const API_CACHE_TTL_MS = 10_000;
/** TTL ключей Redis (чаты, аватары) — секунды, по умолчанию 30 мин */
export const REDIS_KEY_TTL_SEC = Number(process.env.REDIS_KEY_TTL_SEC ?? 30 * 60);
export const TG_CHAT_CACHE_TTL = REDIS_KEY_TTL_SEC;
export const TG_AVATAR_CACHE_TTL = REDIS_KEY_TTL_SEC;
export const TG_API_DELAY_MS = 50;

/** Удалять из БД записи jobs старше N дней */
export const JOBS_RETENTION_DAYS = Number(process.env.JOBS_RETENTION_DAYS ?? 10);
/** Интервал фоновой очистки jobs (часы) */
export const JOBS_PURGE_INTERVAL_HOURS = Number(process.env.JOBS_PURGE_INTERVAL_HOURS ?? 6);
