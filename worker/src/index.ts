import { Worker, Job } from "bullmq";
import IORedis from "ioredis";
import type { JobData } from "./types";
import { spawn } from "node:child_process";
import {
  statSync,
  rmSync,
  mkdirSync,
  existsSync,
  readdirSync,
  renameSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Bot, InputFile } from "grammy";
import { setTimeout as sleep } from "node:timers/promises";

const redisUrl = process.env.REDIS_URL!;
const queueName = process.env.QUEUE_NAME || "tiktok";
const connection = new IORedis(redisUrl, {
  maxRetriesPerRequest: null,
});
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);
const SIZE_LIMIT_MB = Number(process.env.SIZE_LIMIT_MB || "50");
const MAX_BYTES = SIZE_LIMIT_MB * 1024 * 1024;

const TMP_DIR = "/tmp/downloads";
const CACHE_DIR = path.join(TMP_DIR, "cache");
const CACHE_TTL_MS = 24 * 3600 * 1000;
/** Redis: оригинальная ссылка из джобы → URL, по которому лежит кэш (как долго живут .mp4 в cache/) */
const CACHE_REDIS_URL_MAP_TTL_SEC = Math.ceil(CACHE_TTL_MS / 1000);

try {
  mkdirSync(TMP_DIR, { recursive: true });
  mkdirSync(CACHE_DIR, { recursive: true });
} catch (error) {
  console.warn(`Не удалось создать временную директорию ${TMP_DIR}:`, error);
}

function getCacheKey(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 32);
}

function getCachedVideoPath(url: string): string | null {
  const key = getCacheKey(url);
  const cachePath = path.join(CACHE_DIR, `${key}.mp4`);
  if (!existsSync(cachePath)) return null;
  try {
    const stat = statSync(cachePath);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    if (stat.size === 0) return null;
    return cachePath;
  } catch {
    return null;
  }
}

function saveToCache(sourcePath: string, url: string): void {
  try {
    const key = getCacheKey(url);
    const cachePath = path.join(CACHE_DIR, `${key}.mp4`);
    copyFileSync(sourcePath, cachePath);
    console.log(`📦 Видео сохранено в кэш: ${key}`);
  } catch (e) {
    console.warn("Не удалось сохранить в кэш:", e);
  }
}

/** Копии фото для админ-просмотра (TTL как у видео). */
function saveImagesToCache(imagePaths: string[], expandedUrl: string): void {
  if (imagePaths.length === 0) return;
  try {
    const key = getCacheKey(expandedUrl);
    const dir = path.join(CACHE_DIR, key);
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true });
    }
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < imagePaths.length; i++) {
      copyFileSync(imagePaths[i], path.join(dir, `${i}.jpg`));
    }
    writeFileSync(
      path.join(dir, "manifest.json"),
      JSON.stringify({ type: "images", count: imagePaths.length })
    );
    console.log(
      `📦 Альбом сохранён в кэш: ${key} (${imagePaths.length} фото)`
    );
  } catch (e) {
    console.warn("Не удалось сохранить альбом в кэш:", e);
  }
}

function cleanCacheOnStartup(): void {
  try {
    const files = readdirSync(CACHE_DIR);
    const now = Date.now();
    let removed = 0;
    for (const f of files) {
      const fp = path.join(CACHE_DIR, f);
      try {
        const st = statSync(fp);
        if (st.isDirectory()) {
          const manPath = path.join(fp, "manifest.json");
          let mtimeMs = st.mtimeMs;
          if (existsSync(manPath)) {
            mtimeMs = statSync(manPath).mtimeMs;
          }
          if (now - mtimeMs > CACHE_TTL_MS) {
            rmSync(fp, { recursive: true, force: true });
            removed++;
          }
        } else if (now - st.mtimeMs > CACHE_TTL_MS) {
          rmSync(fp, { force: true });
          removed++;
        }
      } catch {
        /* skip */
      }
    }
    if (removed > 0)
      console.log(`🧹 Очищено ${removed} устаревших записей из кэша`);
  } catch {
    /* skip */
  }
}

function parseBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const v = raw.toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

const XRAY_ENABLED = parseBoolEnv("USE_XRAY", true);

const YTDLP_PROXY_SHADOWSOCKS = XRAY_ENABLED
  ? process.env.YTDLP_PROXY_SHADOWSOCKS || "http://xray-shadowsocks:1087"
  : process.env.YTDLP_PROXY_SHADOWSOCKS || "";
const YTDLP_PROXY_HYSTERIA2 = XRAY_ENABLED
  ? process.env.YTDLP_PROXY_HYSTERIA2 || "http://xray:1087"
  : process.env.YTDLP_PROXY_HYSTERIA2 || "";
const YTDLP_PROXY_VLESS = XRAY_ENABLED
  ? process.env.YTDLP_PROXY_VLESS || "http://xray-vless:1087"
  : process.env.YTDLP_PROXY_VLESS || "";

const PROXY_LIST = XRAY_ENABLED
  ? [YTDLP_PROXY_SHADOWSOCKS, YTDLP_PROXY_HYSTERIA2, YTDLP_PROXY_VLESS]
  : [];

if (!XRAY_ENABLED) {
  console.log(
    "🌐 USE_XRAY=false → все Xray-прокси отключены, загрузка идёт напрямую"
  );
}

async function isProxyAvailable(proxyUrl: string): Promise<boolean> {
  try {
    const url = new URL(proxyUrl);
    const hostname = url.hostname;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");

    const { lookup } = await import("node:dns/promises");
    try {
      await Promise.race([
        lookup(hostname),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 1000)
        ),
      ]);

      return true;
    } catch (e) {
      console.log(`⚠️ Прокси ${proxyUrl} недоступен (DNS не резолвится)`);
      return false;
    }
  } catch (e) {
    return true;
  }
}

async function getAvailableProxies(): Promise<string[]> {
  if (!XRAY_ENABLED || PROXY_LIST.length === 0) {
    return [];
  }

  const available: string[] = [];
  for (const proxy of PROXY_LIST) {
    if (await isProxyAvailable(proxy)) {
      available.push(proxy);
    }
  }

  if (available.length === 0) {
    console.log("⚠️ DNS проверка не прошла, но пробуем все прокси");
    return PROXY_LIST;
  }
  return available;
}

function resolveDownloadedFile(outPath: string): string | null {
  if (existsSync(outPath)) {
    return outPath;
  }

  const parsed = path.parse(outPath);
  try {
    const files = readdirSync(parsed.dir);
    const candidate = files.find((file) => file.startsWith(parsed.name));
    if (candidate) {
      return path.join(parsed.dir, candidate);
    }
  } catch (error) {
    console.warn("Не удалось просканировать временную директорию:", error);
  }

  return null;
}

const EXPAND_URL_CACHE_PREFIX = "expand_url:";
/** TTL expand/mapping в Redis (сек); по умолчанию = срок файлового кэша (иначе админка «теряет» ключ после 30 мин) */
const EXPAND_URL_CACHE_TTL = Number(
  process.env.REDIS_EXPAND_URL_TTL_SEC ?? CACHE_REDIS_URL_MAP_TTL_SEC
);

async function rememberCacheUrlMapping(
  originalUrl: string,
  canonicalUrl: string
): Promise<void> {
  try {
    await connection.setex(
      EXPAND_URL_CACHE_PREFIX + getCacheKey(originalUrl),
      CACHE_REDIS_URL_MAP_TTL_SEC,
      canonicalUrl
    );
  } catch (e) {
    console.warn("Redis: не удалось сохранить соответствие URL для кэша:", e);
  }
}

async function expandUrl(url: string): Promise<string> {
  const needsExpand =
    url.includes("vm.tiktok.com") ||
    url.includes("vt.tiktok.com") ||
    url.includes("tiktok.com/t/") ||
    url.includes("://t.co/");

  if (needsExpand) {
    const cacheKey = EXPAND_URL_CACHE_PREFIX + getCacheKey(url);
    try {
      const cached = await connection.get(cacheKey);
      if (cached) {
        console.log(`Expand URL cache hit: ${url} -> ${cached}`);
        return cached;
      }
    } catch (e) {
      console.warn("Redis cache read failed:", e);
    }

    try {
      console.log(`Expanding URL: ${url}`);
      const response = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        const expandedUrl = response.url;
        console.log(`Expanded to: ${expandedUrl}`);
        try {
          await connection.setex(cacheKey, EXPAND_URL_CACHE_TTL, expandedUrl);
        } catch (e) {
          console.warn("Redis cache write failed:", e);
        }
        return expandedUrl;
      }
    } catch (e) {
      console.log(`URL expansion failed: ${e}`);
    }
  }
  return url;
}

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN environment variable is required");
  process.exit(1);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${cmd} exit ${code}: ${stderr}`));
      }
    });
  });
}

/** Парсит stderr yt-dlp для прогресса [download] 45.2% и вызывает callback (с троттлингом) */
function runYtDlpWithProgress(
  args: string[],
  onProgress?: (percent: number) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const p = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let lastReportedPercent = -1;
    const PROGRESS_THROTTLE_PERCENT = 15;
    const PROGRESS_THROTTLE_MS = 4000;
    let lastReportTime = 0;
    p.stderr.on("data", (d: Buffer) => {
      const chunk = d.toString();
      stderr += chunk;
      if (!onProgress) return;
      const match = chunk.match(/\[download\]\s+(\d+(?:\.\d+)?)%/);
      if (match) {
        const pct = Math.round(parseFloat(match[1]));
        const now = Date.now();
        if (pct === 100 || pct - lastReportedPercent >= PROGRESS_THROTTLE_PERCENT || now - lastReportTime > PROGRESS_THROTTLE_MS) {
          lastReportedPercent = pct;
          lastReportTime = now;
          onProgress(pct);
        }
      }
    });

    p.on("close", (code) => {
      if (code === 0) {
        if (onProgress && lastReportedPercent < 100) onProgress(100);
        resolve();
      } else {
        reject(new Error(`yt-dlp exit ${code}: ${stderr}`));
      }
    });
  });
}

async function ytDownload(
  url: string,
  outPath: string,
  onProgress?: (percent: number) => void
): Promise<{ type: "video" | "images"; data: string | string[] }> {
  const proxyNames = ["Shadowsocks", "Hysteria2", "VLESS"];
  let lastError: Error | null = null;

  const baseArgs = [
    "-f",
    "best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best",
    "--no-warnings",
    "--restrict-filenames",
    "--no-playlist",
    "-o",
    outPath,
  ];
  const argsWithProgress = [...baseArgs, url];
  const argsNoProgress = ["--no-progress", ...baseArgs, url];

  const runYtDlp = (args: string[]) =>
    onProgress
      ? runYtDlpWithProgress(args, onProgress)
      : run("yt-dlp", args);

  if (!XRAY_ENABLED || PROXY_LIST.length === 0) {
    console.log("⚠️ Нет доступных прокси, пробуем yt-dlp без прокси...");

    const args = onProgress ? argsWithProgress : argsNoProgress;

    try {
      await runYtDlp(args);
      const detectedPath = resolveDownloadedFile(outPath);
      if (!detectedPath) {
        throw new Error(
          `yt-dlp не создал файл по пути ${outPath}. Проверьте формат и логи.`
        );
      }
      let finalPath = detectedPath;
      if (detectedPath !== outPath) {
        try {
          renameSync(detectedPath, outPath);
          finalPath = outPath;
        } catch (error) {
          console.warn(
            `Не удалось переименовать ${detectedPath} -> ${outPath}:`,
            error
          );
        }
      }
      console.log("✅ Успешно загружено напрямую без прокси");
      return { type: "video", data: finalPath };
    } catch (e: any) {
      lastError = e;
      const errorMsg = e.message || String(e);
      console.log(
        `❌ Прямая загрузка yt-dlp без прокси не сработала: ${errorMsg.substring(
          0,
          200
        )}`
      );
      console.log(
        "Все прямые попытки не сработали, пробуем альтернативные методы..."
      );
      return await tryAlternativeDownload(url, outPath);
    }
  }

  const availableProxies = await getAvailableProxies();
  if (availableProxies.length === 0) {
    console.log("⚠️ Нет доступных прокси, пробуем альтернативные методы...");
    return await tryAlternativeDownload(url, outPath);
  }

  const proxiesToTry = availableProxies;
  for (let i = 0; i < proxiesToTry.length; i++) {
    const proxy = proxiesToTry[i];
    const originalIndex = PROXY_LIST.indexOf(proxy);
    const proxyName =
      originalIndex >= 0 ? proxyNames[originalIndex] : `Proxy${i + 1}`;

    console.log(`Пробуем загрузку через ${proxyName} (${proxy})...`);

    const args = onProgress
      ? [...baseArgs, url, "--proxy", proxy]
      : ["--no-progress", ...baseArgs, url, "--proxy", proxy];

    try {
      await runYtDlp(args);
      const detectedPath = resolveDownloadedFile(outPath);
      if (!detectedPath) {
        throw new Error(
          `yt-dlp не создал файл по пути ${outPath}. Проверьте формат и логи.`
        );
      }
      let finalPath = detectedPath;
      if (detectedPath !== outPath) {
        try {
          renameSync(detectedPath, outPath);
          finalPath = outPath;
        } catch (error) {
          console.warn(
            `Не удалось переименовать ${detectedPath} -> ${outPath}:`,
            error
          );
        }
      }
      console.log(`✅ Успешно загружено через ${proxyName}`);
      return { type: "video", data: finalPath };
    } catch (e: any) {
      lastError = e;
      const errorMsg = e.message || String(e);
      console.log(`❌ ${proxyName} не сработал: ${errorMsg.substring(0, 200)}`);

      continue;
    }
  }

  console.log("Все прокси не сработали, пробуем альтернативные методы...");
  return await tryAlternativeDownload(url, outPath);
}

const IMAGE_DOWNLOAD_CONCURRENCY = Number(
  process.env.IMAGE_DOWNLOAD_CONCURRENCY || "8"
);

async function downloadSingleImage(
  imageUrl: string,
  index: number,
  total: number
): Promise<string | null> {
  const imagePath = path.join(TMP_DIR, `image_${index}.jpg`);
  const proxyNames = ["Shadowsocks", "Hysteria2", "VLESS"];

  // Сначала пробуем без прокси (быстрее на VPS без блокировок)
  if (!XRAY_ENABLED || PROXY_LIST.length === 0) {
    try {
      const args = ["-L", "-o", imagePath, imageUrl];
      await run("curl", args);
      return imagePath;
    } catch (e) {
      console.log(`Failed to download image ${index + 1}/${total}: ${e}`);
      return null;
    }
  }

  for (let j = 0; j < PROXY_LIST.length; j++) {
    const proxy = PROXY_LIST[j];
    try {
      const args = ["-L", "--proxy", proxy, "-o", imagePath, imageUrl];
      await run("curl", args);
      return imagePath;
    } catch (e) {
      if (j === PROXY_LIST.length - 1) {
        try {
          const args = ["-L", "-o", imagePath, imageUrl];
          await run("curl", args);
          return imagePath;
        } catch (e2) {
          console.log(`Failed to download image ${index + 1}/${total}: ${e2}`);
          return null;
        }
      }
    }
  }

  return null;
}

async function downloadImages(imageUrls: string[]): Promise<string[]> {
  const downloadedImages: (string | null)[] = new Array(imageUrls.length);

  for (
    let chunkStart = 0;
    chunkStart < imageUrls.length;
    chunkStart += IMAGE_DOWNLOAD_CONCURRENCY
  ) {
    const chunk = imageUrls.slice(
      chunkStart,
      chunkStart + IMAGE_DOWNLOAD_CONCURRENCY
    );
    const results = await Promise.all(
      chunk.map((url, idx) =>
        downloadSingleImage(url, chunkStart + idx, imageUrls.length)
      )
    );
    for (let i = 0; i < results.length; i++) {
      downloadedImages[chunkStart + i] = results[i];
    }
  }

  return downloadedImages.filter((p): p is string => p !== null);
}

async function sendImagesInBatches(
  chatId: number,
  images: string[],
  messageId: number,
  ackMessageId: number
) {
  const batchSize = 10;

  for (let i = 0; i < images.length; i += batchSize) {
    const batch = images.slice(i, i + batchSize);

    try {
      await bot.api.sendChatAction(chatId, "upload_photo");

      if (batch.length === 1) {
        await bot.api.sendPhoto(chatId, new InputFile(batch[0]), {
          reply_to_message_id: messageId,
        });
      } else {
        const media = batch.map((img) => ({
          type: "photo" as const,
          media: new InputFile(img),
        }));

        await bot.api.sendMediaGroup(chatId, media, {
          reply_to_message_id: messageId,
        });
      }

      if (i + batchSize < images.length) {
        await sleep(1000);
      }
    } catch (e) {
      console.log(
        `Failed to send batch ${Math.floor(i / batchSize) + 1}: ${e}`
      );
    }
  }

  await bot.api.deleteMessage(chatId, ackMessageId).catch(() => {});
}

const TWITTER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function isTwitterStatusUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\./, "").toLowerCase();
    if (
      h !== "twitter.com" &&
      h !== "x.com" &&
      h !== "mobile.twitter.com"
    ) {
      return false;
    }
    // /user/status/ID и /i/web/status/ID — в pathname всегда есть /status/<digits>
    return /\/status\/\d{10,}/.test(u.pathname);
  } catch {
    return false;
  }
}

function extractTwitterStatusId(url: string): string | null {
  const web = url.match(/\/i\/web\/status\/(\d{10,})/);
  if (web) return web[1];
  const st = url.match(/\/status\/(\d{10,})/);
  if (st) return st[1];
  return null;
}

function normalizeTwitterImageUrl(raw: string): string {
  let u = raw.replace(/&amp;/g, "&").trim();
  if (!u.includes("pbs.twimg.com/media/")) return u;
  try {
    const parsed = new URL(u);
    if (!parsed.searchParams.has("format")) {
      parsed.searchParams.set("format", "jpg");
    }
    parsed.searchParams.set("name", "orig");
    return parsed.toString();
  } catch {
    return u.replace(/([?&])name=[^&]*/g, "$1name=orig");
  }
}

function collectPbsMediaUrlsFromJson(obj: unknown, out: Set<string>): void {
  if (typeof obj === "string") {
    const re =
      /https:\/\/pbs\.twimg\.com\/media\/[A-Za-z0-9_-]+(?:\?[^"'\\\s]*)?/gi;
    let m: RegExpExecArray | null;
    const s = obj;
    while ((m = re.exec(s)) !== null) {
      out.add(normalizeTwitterImageUrl(m[0]));
    }
  } else if (Array.isArray(obj)) {
    for (const x of obj) collectPbsMediaUrlsFromJson(x, out);
  } else if (obj !== null && typeof obj === "object") {
    for (const v of Object.values(obj)) collectPbsMediaUrlsFromJson(v, out);
  }
}

/** Фото-твиты: yt-dlp даёт «No video» — тянем URL картинок через oembed / syndication. */
async function tryTwitterPhotoImageUrls(tweetUrl: string): Promise<string[]> {
  const canonical = (() => {
    try {
      const u = new URL(tweetUrl);
      u.hash = "";
      return u.toString();
    } catch {
      return tweetUrl;
    }
  })();

  const fromHtml = (html: string): string[] => {
    const found = new Set<string>();
    const re =
      /https:\/\/pbs\.twimg\.com\/media\/[A-Za-z0-9_-]+(?:\?[^"'\\\s<>]*)?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      found.add(normalizeTwitterImageUrl(m[0]));
    }
    return [...found];
  };

  const oembedPageUrl = (() => {
    try {
      const u = new URL(canonical);
      const h = u.hostname.replace(/^www\./, "").toLowerCase();
      if (h === "x.com") u.hostname = "twitter.com";
      return u.toString();
    } catch {
      return canonical;
    }
  })();

  try {
    const oembedUrl = `https://publish.twitter.com/oembed?url=${encodeURIComponent(
      oembedPageUrl
    )}&omit_script=true&dnt=true`;
    const res = await fetch(oembedUrl, {
      headers: { "User-Agent": TWITTER_UA, Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const j = (await res.json()) as { html?: string };
      const imgs = fromHtml(j.html || "");
      if (imgs.length > 0) {
        console.log(
          `🐦 Twitter oembed: найдено ${imgs.length} изображений`
        );
        return imgs;
      }
    }
  } catch (e) {
    console.log(`Twitter oembed failed: ${e}`);
  }

  const tweetId = extractTwitterStatusId(canonical);
  if (tweetId) {
    const syndicationUrls = [
      `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en`,
      `https://cdn.syndication.twimg.com/tweet-result?id=${tweetId}&lang=en&token=0`,
    ];
    for (const api of syndicationUrls) {
      try {
        const res = await fetch(api, {
          headers: {
            "User-Agent": TWITTER_UA,
            Accept: "application/json,text/plain,*/*",
          },
          signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) continue;
        const text = await res.text();
        let data: unknown;
        try {
          data = JSON.parse(text);
        } catch {
          const imgs = fromHtml(text);
          if (imgs.length > 0) {
            console.log(
              `🐦 Twitter syndication (HTML): ${imgs.length} изображений`
            );
            return imgs;
          }
          continue;
        }
        const found = new Set<string>();
        collectPbsMediaUrlsFromJson(data, found);
        if (found.size > 0) {
          const imgs = [...found];
          console.log(
            `🐦 Twitter syndication JSON: ${imgs.length} изображений`
          );
          return imgs;
        }
      } catch (e) {
        console.log(`Twitter syndication failed (${api}): ${e}`);
      }
    }
  }

  return [];
}

function isTikTokPageUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes("tiktok.com") ||
    u.includes("vm.tiktok.com") ||
    u.includes("vt.tiktok.com")
  );
}

async function tryAlternativeDownload(
  url: string,
  outPath: string
): Promise<{ type: "video" | "images"; data: string | string[] }> {
  if (isTwitterStatusUrl(url)) {
    const twImages = await tryTwitterPhotoImageUrls(url);
    if (twImages.length > 0) {
      return { type: "images", data: twImages };
    }
    console.log(
      "🐦 Twitter: не удалось получить изображения через oembed/syndication"
    );
  }

  if (!isTikTokPageUrl(url)) {
    throw new Error("All download methods failed");
  }

  const services = [
    `https://tikwm.com/api/?url=${encodeURIComponent(url)}`,
    `https://api.tikmate.app/api/lookup?id=${
      url.split("/").pop()?.split("?")[0]
    }`,
  ];

  const availableProxies =
    XRAY_ENABLED && PROXY_LIST.length > 0 ? await getAvailableProxies() : [];
  const proxyNames = ["Shadowsocks", "Hysteria2", "VLESS"];

  for (const serviceUrl of services) {
    let serviceSuccess = false;
    for (let i = 0; i < availableProxies.length && !serviceSuccess; i++) {
      const proxy = availableProxies[i];
      const originalIndex = PROXY_LIST.indexOf(proxy);
      const proxyName =
        originalIndex >= 0 ? proxyNames[originalIndex] : `Proxy${i + 1}`;

      try {
        console.log(`Trying service через ${proxyName}: ${serviceUrl}`);

        let fetchOptions: RequestInit = {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          signal: AbortSignal.timeout(15000),
        };

        const curlArgs = ["-L", "--proxy", proxy, serviceUrl];
        const curlOutput = await new Promise<string>((resolve, reject) => {
          const curl = spawn("curl", curlArgs);
          let output = "";
          curl.stdout.on("data", (data: Buffer) => (output += data.toString()));
          curl.stderr.on("data", (data: Buffer) => {});
          curl.on("close", (code: number) => {
            if (code === 0) resolve(output);
            else reject(new Error(`curl exit ${code}`));
          });
        });

        const data = JSON.parse(curlOutput) as any;
        serviceSuccess = true;

        if (data.data?.images && Array.isArray(data.data.images)) {
          console.log(
            `Found photo post with ${data.data.images.length} images`
          );
          return { type: "images", data: data.data.images };
        }

        let videoUrl = null;
        if (data.data?.hdplay) {
          videoUrl = data.data.hdplay;
        } else if (data.data?.play) {
          videoUrl = data.data.play;
        } else if (data.video) {
          videoUrl = data.video;
        }

        if (videoUrl) {
          console.log(`Found video URL: ${videoUrl}`);
          await downloadVideo(videoUrl, outPath);
          return { type: "video", data: outPath };
        }
      } catch (e: any) {
        console.log(`Service failed через ${proxyName}: ${e.message || e}`);

        continue;
      }
    }

    if (!serviceSuccess) {
      try {
        console.log(`Trying service без прокси: ${serviceUrl}`);
        const response = await fetch(serviceUrl, {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          signal: AbortSignal.timeout(15000),
        });

        if (!response.ok) continue;

        const data = (await response.json()) as any;

        if (data.data?.images && Array.isArray(data.data.images)) {
          console.log(
            `Found photo post with ${data.data.images.length} images`
          );
          return { type: "images", data: data.data.images };
        }

        let videoUrl = null;
        if (data.data?.hdplay) {
          videoUrl = data.data.hdplay;
        } else if (data.data?.play) {
          videoUrl = data.data.play;
        } else if (data.video) {
          videoUrl = data.video;
        }

        if (videoUrl) {
          console.log(`Found video URL: ${videoUrl}`);
          await downloadVideo(videoUrl, outPath);
          return { type: "video", data: outPath };
        }
      } catch (e) {
        console.log(`Service failed без прокси: ${e}`);
        continue;
      }
    }
  }

  throw new Error("All download methods failed");
}

async function downloadVideo(videoUrl: string, outPath: string): Promise<void> {
  const proxyNames = ["Shadowsocks", "Hysteria2", "VLESS"];
  let lastError: Error | null = null;

  const availableProxies =
    XRAY_ENABLED && PROXY_LIST.length > 0 ? await getAvailableProxies() : [];
  const proxiesToTry =
    availableProxies.length > 0 ? availableProxies : PROXY_LIST;

  for (let i = 0; i < proxiesToTry.length; i++) {
    const proxy = proxiesToTry[i];
    const originalIndex = PROXY_LIST.indexOf(proxy);
    const proxyName =
      originalIndex >= 0 ? proxyNames[originalIndex] : `Proxy${i + 1}`;

    try {
      console.log(`Скачиваем видео через ${proxyName} (${proxy})...`);
      const args = ["-L", "-o", outPath, "--proxy", proxy, videoUrl];
      await run("curl", args);
      console.log(`✅ Видео успешно скачано через ${proxyName}`);
      return;
    } catch (e: any) {
      lastError = e;
      console.log(`❌ ${proxyName} не сработал: ${e.message || e}`);

      continue;
    }
  }

  try {
    console.log("Пробуем скачать видео без прокси (curl без --proxy)...");
    await run("curl", ["-L", "-o", outPath, videoUrl]);
    console.log("✅ Видео успешно скачано без прокси");
    return;
  } catch (e: any) {
    lastError = e;
  }

  throw new Error(
    `Не удалось скачать видео через все прокси. Последняя ошибка: ${
      lastError?.message || "unknown"
    }`
  );
}

async function ffprobeDurationMs(file: string): Promise<number> {
  const args = [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "format=duration",
    "-of",
    "default=nokey=1:noprint_wrappers=1",
    file,
  ];
  let out = "";
  await new Promise<void>((resolve, reject) => {
    const p = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", (c) => {
      if (c === 0) {
        resolve();
      } else {
        reject(new Error("ffprobe failed"));
      }
    });
  });
  const s = parseFloat(out.trim());
  return Math.max(0, Math.round(s * 1000));
}

async function recompressToTarget(
  inFile: string,
  outFile: string,
  targetBytes: number
): Promise<void> {
  const durMs = (await ffprobeDurationMs(inFile)) || 1;

  const usable = Math.floor(targetBytes * 0.94);

  const seconds = Math.max(1, Math.round(durMs / 1000));

  const audioK = 96_000;
  const totalBitrate = Math.max(180_000, Math.floor((usable * 8) / seconds));
  const videoBitrate = Math.max(120_000, totalBitrate - audioK);

  console.log(
    `Recompressing: duration=${durMs}ms, target=${targetBytes}B, videoBitrate=${videoBitrate}`
  );

  const ffmpegPreset = process.env.FFMPEG_PRESET || "veryfast";
  const args = [
    "-y",
    "-i",
    inFile,
    "-c:v",
    "libx264",
    "-preset",
    ffmpegPreset,
    "-b:v",
    String(videoBitrate),
    "-maxrate",
    String(videoBitrate),
    "-bufsize",
    String(videoBitrate * 2),
    "-c:a",
    "aac",
    "-b:a",
    "96k",
    "-movflags",
    "+faststart",
    outFile,
  ];
  await run("ffmpeg", args);
}

async function recordStat(payload: any): Promise<void> {
  try {
    const response = await fetch("http://bot:3000/stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      console.error("Failed to record stat:", response.statusText);
    }
  } catch (e) {
    console.error("Error recording stat:", e);
  }
}

function buildStatPayload(
  job: Job,
  started: number,
  status: string,
  bytes: number,
  errorMessage?: string
) {
  const data = job.data as JobData;
  return {
    ts: started,
    url: data.url,
    status,
    bytes,
    duration_ms: Date.now() - started,
    chat_id: data.chatId,
    user_id: data.userId ?? null,
    username: data.username ?? null,
    first_name: data.firstName ?? null,
    platform: data.platform ?? null,
    error_message: errorMessage ?? null,
  };
}

const worker = new Worker(
  queueName,
  async (job: Job) => {
    const { url, chatId, messageId, ackMessageId, sizeLimitMB } =
      job.data as JobData;
    const started = Date.now();
    const id = randomUUID();
    const raw = path.join(TMP_DIR, `${id}.mp4`);
    const out = path.join(TMP_DIR, `${id}.out.mp4`);

    console.log(`Processing job ${job.id}: ${url}`);

    try {
      const expandedUrl = await expandUrl(url);
      await rememberCacheUrlMapping(url, expandedUrl);

      const cachedPath = getCachedVideoPath(expandedUrl);
      if (cachedPath) {
        console.log(`📦 Кэш-хит, используем сохранённое видео`);
        const bytes = statSync(cachedPath).size;
        await bot.api.sendChatAction(chatId, "upload_video");
        await bot.api.sendVideo(chatId, new InputFile(cachedPath), {
          reply_to_message_id: messageId,
        });
        await bot.api.deleteMessage(chatId, ackMessageId).catch(() => {});
        await recordStat(buildStatPayload(job, started, "cached", bytes));
        return;
      }

      const progressCallback = async (percent: number) => {
        try {
          await bot.api.editMessageText(
            chatId,
            ackMessageId,
            percent < 100
              ? `Загрузка… ${percent}%`
              : `Обработка…`
          );
        } catch {
          /* Игнорируем ошибки редактирования (rate limit и т.п.) */
        }
      };

      const result = await ytDownload(expandedUrl, raw, progressCallback);

      if (result.type === "images") {
        console.log(`Processing photo post with ${result.data.length} images`);
        const imageUrls = result.data as string[];
        const downloadedImages = await downloadImages(imageUrls);

        if (downloadedImages.length > 0) {
          const totalBytes = downloadedImages.reduce(
            (sum, img) => sum + statSync(img).size,
            0
          );

          await sendImagesInBatches(
            chatId,
            downloadedImages,
            messageId,
            ackMessageId
          );

          await recordStat(buildStatPayload(job, started, "success", totalBytes));

          saveImagesToCache(downloadedImages, expandedUrl);

          downloadedImages.forEach((img) => {
            try {
              rmSync(img, { force: true });
            } catch {}
          });
          return;
        } else {
          throw new Error("Failed to download any images");
        }
      }

      const videoPath = result.data as string;
      if (!existsSync(videoPath)) {
        throw new Error(
          `Видео не найдено по пути ${videoPath}. Проверьте лог загрузки.`
        );
      }
      let bytes = statSync(videoPath).size;
      console.log(`Downloaded ${bytes} bytes`);

      if (bytes > MAX_BYTES) {
        console.log(
          `File too large (${bytes} > ${MAX_BYTES}), attempting compression...`
        );

        await recompressToTarget(videoPath, out, MAX_BYTES);
        bytes = statSync(out).size;
        console.log(`After compression: ${bytes} bytes`);

        if (bytes > MAX_BYTES) {
          await bot.api.editMessageText(
            chatId,
            ackMessageId,
            `❌ Не могу уложиться в ${SIZE_LIMIT_MB} MB даже после сжатия. Попробуйте другую ссылку.`
          );
          await recordStat(buildStatPayload(job, started, "too_large", bytes));
          return;
        }

        try {
          rmSync(videoPath, { force: true });
        } catch {}

        await bot.api.sendChatAction(chatId, "upload_video");
        await bot.api.sendVideo(chatId, new InputFile(out), {
          reply_to_message_id: messageId,
        });
        await bot.api.deleteMessage(chatId, ackMessageId).catch(() => {});

        saveToCache(out, expandedUrl);
        await recordStat(buildStatPayload(job, started, "compressed", bytes));
        return;
      }

      await bot.api.sendChatAction(chatId, "upload_video");
      await bot.api.sendVideo(chatId, new InputFile(videoPath), {
        reply_to_message_id: messageId,
      });
      await bot.api.deleteMessage(chatId, ackMessageId).catch(() => {});

      saveToCache(videoPath, expandedUrl);
      await recordStat(buildStatPayload(job, started, "success", bytes));
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(`Job ${job.id} failed:`, err);
      const errorText = `❌ Ошибка: ${err.message}`;
      try {
        await bot.api.editMessageText(chatId, ackMessageId, errorText);
      } catch (editErr: unknown) {
        const desc = (editErr as { description?: string })?.description ?? "";
        if (!desc.includes("message is not modified")) {
          console.warn("editMessageText failed:", editErr);
        }
      }
      await recordStat(
        buildStatPayload(
          job,
          started,
          "failed",
          0,
          err.message.slice(0, 500)
        )
      );
      throw err;
    } finally {
      try {
        rmSync(raw, { force: true });
      } catch {}
      try {
        rmSync(out, { force: true });
      } catch {}
    }
  },
  {
    connection,
    concurrency: Number(process.env.MAX_CONCURRENCY || "2"),
  }
);

worker.on("failed", (job, err) => {
  console.error("Job failed:", job?.id, err);
});

worker.on("completed", (job) => {
  console.log("Job completed:", job.id);
});

worker.on("error", (err) => {
  console.error("Worker error:", err);
});

cleanCacheOnStartup();
const CACHE_CLEANUP_INTERVAL_MS =
  Number(process.env.CACHE_CLEANUP_INTERVAL_MINUTES || "60") * 60 * 1000;
setInterval(cleanCacheOnStartup, CACHE_CLEANUP_INTERVAL_MS);
console.log("🔧 Worker started successfully");
console.log(`📊 Concurrency: ${process.env.MAX_CONCURRENCY || "2"}`);
console.log(`📏 Size limit: ${SIZE_LIMIT_MB} MB`);
console.log(
  `🌐 Proxies: Shadowsocks=${YTDLP_PROXY_SHADOWSOCKS}, Hysteria2=${YTDLP_PROXY_HYSTERIA2}, VLESS=${YTDLP_PROXY_VLESS}`
);
