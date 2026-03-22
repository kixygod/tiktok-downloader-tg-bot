import { createHash } from "node:crypto";
import { existsSync, statSync, readFileSync } from "node:fs";
import path from "node:path";
import type IORedis from "ioredis";

const TMP_DOWNLOADS = process.env.CACHE_DOWNLOADS_ROOT || "/tmp/downloads";
export const CACHE_DIR = path.join(TMP_DOWNLOADS, "cache");
const CACHE_TTL_MS = 24 * 3600 * 1000;
const EXPAND_PREFIX = "expand_url:";

export function getCacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

function isFresh(mtimeMs: number): boolean {
  return Date.now() - mtimeMs <= CACHE_TTL_MS;
}

export function getCachedVideoPathForKey(key: string): string | null {
  const p = path.join(CACHE_DIR, `${key}.mp4`);
  if (!existsSync(p)) return null;
  try {
    const st = statSync(p);
    if (st.size === 0 || !isFresh(st.mtimeMs)) return null;
    return p;
  } catch {
    return null;
  }
}

export interface ImageManifest {
  type: "images";
  count: number;
}

export function getImageCacheDirForKey(key: string): string | null {
  const dir = path.join(CACHE_DIR, key);
  if (!existsSync(dir)) return null;
  try {
    const manPath = path.join(dir, "manifest.json");
    if (!existsSync(manPath)) return null;
    const raw = readFileSync(manPath, "utf-8");
    const m = JSON.parse(raw) as ImageManifest;
    if (m.type !== "images" || m.count < 1) return null;
    const st = statSync(manPath);
    if (!isFresh(st.mtimeMs)) return null;
    for (let i = 0; i < m.count; i++) {
      if (!existsSync(path.join(dir, `${i}.jpg`))) return null;
    }
    return dir;
  } catch {
    return null;
  }
}

export type CacheProbeKind = "video" | "images" | null;

/** Ключ кэша, по которому реально лежат файлы (первый подходящий из url + expanded) */
export async function resolveCacheKeyForUrl(
  url: string,
  redis: IORedis | null
): Promise<string | null> {
  const keysToTry: string[] = [getCacheKey(url)];
  if (redis) {
    try {
      const expanded = await redis.get(EXPAND_PREFIX + getCacheKey(url));
      if (expanded && expanded !== url) {
        keysToTry.push(getCacheKey(expanded));
      }
    } catch {
      /* ignore */
    }
  }
  for (const key of keysToTry) {
    if (getCachedVideoPathForKey(key)) return key;
  }
  for (const key of keysToTry) {
    if (getImageCacheDirForKey(key)) return key;
  }
  return null;
}

export async function probeCacheForUrl(
  url: string,
  redis: IORedis | null
): Promise<{ kind: CacheProbeKind; imageCount: number }> {
  const key = await resolveCacheKeyForUrl(url, redis);
  if (!key) return { kind: null, imageCount: 0 };
  if (getCachedVideoPathForKey(key)) {
    return { kind: "video", imageCount: 0 };
  }
  const imgDir = getImageCacheDirForKey(key);
  if (imgDir) {
    try {
      const man = JSON.parse(
        readFileSync(path.join(imgDir, "manifest.json"), "utf-8")
      ) as ImageManifest;
      return { kind: "images", imageCount: man.count };
    } catch {
      return { kind: null, imageCount: 0 };
    }
  }
  return { kind: null, imageCount: 0 };
}

export function getImageFilePath(cacheKey: string, index: number): string | null {
  const dir = getImageCacheDirForKey(cacheKey);
  if (!dir) return null;
  const p = path.join(dir, `${index}.jpg`);
  return existsSync(p) ? p : null;
}
