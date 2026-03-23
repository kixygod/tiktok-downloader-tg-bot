import { readFileSync } from "node:fs";
import path from "node:path";
import type IORedis from "ioredis";
import {
  getCacheKey,
  getCachedVideoPathForKey,
  getImageCacheDirForKey,
  CACHE_REDIS_MAP_TTL_SEC,
  EXPAND_PREFIX,
} from "./cacheFs";

/** Дублируем логику воркера: только URL, где без редиректа ключ кэша не совпадёт. */
function needsHeadExpand(url: string): boolean {
  return (
    url.includes("vm.tiktok.com") ||
    url.includes("vt.tiktok.com") ||
    url.includes("tiktok.com/t/") ||
    url.includes("://t.co/")
  );
}

async function expandUrlViaHead(url: string): Promise<string> {
  if (!needsHeadExpand(url)) return url;
  try {
    const response = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (response.ok && response.url) return response.url;
  } catch {
    /* ignore */
  }
  return url;
}

function buildCanonicalCandidates(original: string, expanded: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.trim();
    if (t && !out.includes(t)) out.push(t);
  };
  add(original);
  add(expanded);
  try {
    const u = new URL(expanded);
    u.search = "";
    add(u.toString());
  } catch {
    /* ignore */
  }
  try {
    const u = new URL(original);
    u.search = "";
    add(u.toString());
  } catch {
    /* ignore */
  }
  return out;
}

export type RehydrateResult = {
  ok: boolean;
  already: boolean;
  kind: "video" | "images" | null;
  imageCount: number;
  message?: string;
};

/**
 * Ищет файлы кэша на диске по вариантам URL, восстанавливает Redis expand_url:* → канонический URL.
 */
export async function rehydrateCacheMappingForJobUrl(
  jobUrl: string,
  redis: IORedis
): Promise<RehydrateResult> {
  const normalized = jobUrl.trim();
  if (!normalized) {
    return { ok: false, already: false, kind: null, imageCount: 0, message: "Пустой URL" };
  }

  const probeVideo = (key: string) => getCachedVideoPathForKey(key);
  const probeImages = (key: string) => {
    const dir = getImageCacheDirForKey(key);
    if (!dir) return 0;
    try {
      const raw = readFileSync(path.join(dir, "manifest.json"), "utf-8");
      const m = JSON.parse(raw) as { count?: number };
      return typeof m.count === "number" ? m.count : 0;
    } catch {
      return 0;
    }
  };

  try {
    const existing = await redis.get(EXPAND_PREFIX + getCacheKey(normalized));
    if (existing) {
      const key = getCacheKey(existing);
      if (probeVideo(key)) {
        return {
          ok: true,
          already: true,
          kind: "video",
          imageCount: 0,
          message: "Уже связано",
        };
      }
      const n = probeImages(key);
      if (n > 0) {
        return {
          ok: true,
          already: true,
          kind: "images",
          imageCount: n,
          message: "Уже связано",
        };
      }
    }
  } catch {
    /* ignore */
  }

  for (const candidate of buildCanonicalCandidates(normalized, normalized)) {
    const key = getCacheKey(candidate);
    if (probeVideo(key)) {
      try {
        await redis.setex(
          EXPAND_PREFIX + getCacheKey(normalized),
          CACHE_REDIS_MAP_TTL_SEC,
          candidate
        );
      } catch (e) {
        return {
          ok: false,
          already: false,
          kind: null,
          imageCount: 0,
          message: String(e),
        };
      }
      return {
        ok: true,
        already: false,
        kind: "video",
        imageCount: 0,
        message: "Связь с видео восстановлена",
      };
    }
    const imgCount = probeImages(key);
    if (imgCount > 0) {
      try {
        await redis.setex(
          EXPAND_PREFIX + getCacheKey(normalized),
          CACHE_REDIS_MAP_TTL_SEC,
          candidate
        );
      } catch (e) {
        return {
          ok: false,
          already: false,
          kind: null,
          imageCount: 0,
          message: String(e),
        };
      }
      return {
        ok: true,
        already: false,
        kind: "images",
        imageCount: imgCount,
        message: "Связь с альбомом восстановлена",
      };
    }
  }

  const expanded = await expandUrlViaHead(normalized);
  if (expanded !== normalized) {
    for (const candidate of buildCanonicalCandidates(normalized, expanded)) {
      const key = getCacheKey(candidate);
      if (probeVideo(key)) {
        try {
          await redis.setex(
            EXPAND_PREFIX + getCacheKey(normalized),
            CACHE_REDIS_MAP_TTL_SEC,
            candidate
          );
        } catch (e) {
          return {
            ok: false,
            already: false,
            kind: null,
            imageCount: 0,
            message: String(e),
          };
        }
        return {
          ok: true,
          already: false,
          kind: "video",
          imageCount: 0,
          message: "Связь с видео восстановлена (редирект)",
        };
      }
      const imgCount = probeImages(key);
      if (imgCount > 0) {
        try {
          await redis.setex(
            EXPAND_PREFIX + getCacheKey(normalized),
            CACHE_REDIS_MAP_TTL_SEC,
            candidate
          );
        } catch (e) {
          return {
            ok: false,
            already: false,
            kind: null,
            imageCount: 0,
            message: String(e),
          };
        }
        return {
          ok: true,
          already: false,
          kind: "images",
          imageCount: imgCount,
          message: "Связь с альбомом восстановлена (редирект)",
        };
      }
    }
  }

  return {
    ok: false,
    already: false,
    kind: null,
    imageCount: 0,
    message: "Файл кэша не найден или срок истёк",
  };
}
