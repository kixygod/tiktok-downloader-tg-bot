export const redisUrl = process.env.REDIS_URL!;
export const queueName = process.env.QUEUE_NAME || "tiktok";
export const SIZE_LIMIT_MB = Number(process.env.SIZE_LIMIT_MB || "50");
export const MAX_BYTES = SIZE_LIMIT_MB * 1024 * 1024;

export const TMP_DIR = "/tmp/downloads";
export const CACHE_DIR = `${TMP_DIR}/cache`;
export const CACHE_TTL_MS = 24 * 3600 * 1000;
export const EXPAND_URL_CACHE_PREFIX = "expand_url:";
export const EXPAND_URL_CACHE_TTL = 6 * 3600;

export const IMAGE_DOWNLOAD_CONCURRENCY = Number(
  process.env.IMAGE_DOWNLOAD_CONCURRENCY || "8"
);

export function parseBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const v = raw.toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

export const XRAY_ENABLED = parseBoolEnv("USE_XRAY", true);
