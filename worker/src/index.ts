import { Worker, Job } from "bullmq";
import IORedis from "ioredis";
import { spawn } from "node:child_process";
import {
  statSync,
  rmSync,
  mkdirSync,
  existsSync,
  readdirSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
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
try {
  mkdirSync(TMP_DIR, { recursive: true });
} catch (error) {
  console.warn(`Не удалось создать временную директорию ${TMP_DIR}:`, error);
}

// Флаг для полного отключения Xray/прокси (например, на VPS без блокировок)
function parseBoolEnv(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const v = raw.toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return defaultValue;
}

const XRAY_ENABLED = parseBoolEnv("USE_XRAY", true);

// Прокси для fallback: сначала Shadowsocks, потом Hysteria2, потом VLESS
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

// Функция для проверки доступности прокси (проверяет реальный HTTP запрос)
async function isProxyAvailable(proxyUrl: string): Promise<boolean> {
  try {
    const url = new URL(proxyUrl);
    const hostname = url.hostname;
    const port = url.port || (url.protocol === "https:" ? "443" : "80");

    // Пробуем резолвить hostname через DNS (быстрая проверка)
    const { lookup } = await import("node:dns/promises");
    try {
      await Promise.race([
        lookup(hostname),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), 1000)
        ),
      ]);
      // DNS резолвится, считаем прокси доступным
      return true;
    } catch (e) {
      // DNS не резолвится - возможно контейнер не запущен
      console.log(`⚠️ Прокси ${proxyUrl} недоступен (DNS не резолвится)`);
      return false;
    }
  } catch (e) {
    // Если не удалось распарсить URL, все равно пробуем использовать
    return true;
  }
}

// Получаем список доступных прокси
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
  // Если ни один прокси не прошел проверку DNS, все равно возвращаем все
  // (возможно, проверка DNS не работает в Docker сети, но прокси доступны)
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

async function expandUrl(url: string): Promise<string> {
  if (
    url.includes("vm.tiktok.com") ||
    url.includes("vt.tiktok.com") ||
    url.includes("tiktok.com/t/")
  ) {
    try {
      console.log(`Expanding URL: ${url}`);
      const response = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(10000),
      });

      if (response.ok) {
        const expandedUrl = response.url;
        console.log(`Expanded to: ${expandedUrl}`);
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

async function ytDownload(
  url: string,
  outPath: string
): Promise<{ type: "video" | "images"; data: string | string[] }> {
  const proxyNames = ["Shadowsocks", "Hysteria2", "VLESS"];
  let lastError: Error | null = null;

  // Получаем список доступных прокси
  const availableProxies = await getAvailableProxies();

  // 1) Если Xray/прокси выключены — сразу пробуем yt-dlp НАПРЯМУЮ без прокси
  if (!XRAY_ENABLED || (availableProxies.length === 0 && PROXY_LIST.length === 0)) {
    console.log("⚠️ Нет доступных прокси, пробуем yt-dlp без прокси...");

    // Берём прогрессивный MP4 с H.264 (avc1) без мерджа/ffmpeg
    const args = [
      "-f",
      "best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best",
      "--no-warnings",
      "--no-progress",
      "--restrict-filenames",
      "--no-playlist",
      "-o",
      outPath,
      url,
    ];

    try {
      await run("yt-dlp", args);
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
      console.log("Все прямые попытки не сработали, пробуем альтернативные методы...");
      return await tryAlternativeDownload(url, outPath);
    }
  }

  // 2) Если прокси включены — пробуем каждый доступный прокси по очереди
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

    const args = [
      "-f",
      "best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best",
      "--no-warnings",
      "--no-progress",
      "--restrict-filenames",
      "--no-playlist",
      "-o",
      outPath,
      url,
      "--proxy",
      proxy,
    ];

    try {
      await run("yt-dlp", args);
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
      // Продолжаем пробовать следующий прокси
      continue;
    }
  }

  // Если все прокси не сработали, пробуем альтернативные методы
  console.log("Все прокси не сработали, пробуем альтернативные методы...");
  return await tryAlternativeDownload(url, outPath);
}

async function downloadImages(imageUrls: string[]): Promise<string[]> {
  const downloadedImages: string[] = [];
  const proxyNames = ["Shadowsocks", "Hysteria2", "VLESS"];

  for (let i = 0; i < imageUrls.length; i++) {
    const imageUrl = imageUrls[i];
    const imagePath = path.join(TMP_DIR, `image_${i}.jpg`);

    let downloaded = false;

    if (XRAY_ENABLED && PROXY_LIST.length > 0) {
      // Пробуем каждый прокси для каждой картинки
      for (let j = 0; j < PROXY_LIST.length && !downloaded; j++) {
        const proxy = PROXY_LIST[j];
        const proxyName = proxyNames[j] || `Proxy${j + 1}`;

        try {
          console.log(
            `Downloading image ${i + 1}/${
              imageUrls.length
            } через ${proxyName}: ${imageUrl}`
          );
          const args = ["-L", "--proxy", proxy, "-o", imagePath, imageUrl];
          await run("curl", args);
          downloadedImages.push(imagePath);
          downloaded = true;
        } catch (e) {
          console.log(
            `Failed to download image ${i + 1} через ${proxyName}: ${e}`
          );
          if (j === PROXY_LIST.length - 1) {
            console.log(`Все прокси не сработали для изображения ${i + 1}`);
          }
        }
      }
    }

    // Если прокси выключены или все не сработали - пробуем без прокси
    if (!downloaded) {
      try {
        console.log(
          `Downloading image ${i + 1}/${imageUrls.length} без прокси: ${imageUrl}`
        );
        const args = ["-L", "-o", imagePath, imageUrl];
        await run("curl", args);
        downloadedImages.push(imagePath);
        downloaded = true;
      } catch (e) {
        console.log(
          `Failed to download image ${i + 1} без прокси: ${e}`
        );
      }
    }
  }

  return downloadedImages;
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

async function tryAlternativeDownload(
  url: string,
  outPath: string
): Promise<{ type: "video" | "images"; data: string | string[] }> {
  const services = [
    `https://tikwm.com/api/?url=${encodeURIComponent(url)}`,
    `https://api.tikmate.app/api/lookup?id=${
      url.split("/").pop()?.split("?")[0]
    }`,
  ];

  // Получаем доступные прокси для fetch запросов
  const availableProxies = await getAvailableProxies();
  const proxyNames = ["Shadowsocks", "Hysteria2", "VLESS"];

  for (const serviceUrl of services) {
    // Пробуем каждый доступный прокси для запроса к сервису
    let serviceSuccess = false;
    for (let i = 0; i < availableProxies.length && !serviceSuccess; i++) {
      const proxy = availableProxies[i];
      const originalIndex = PROXY_LIST.indexOf(proxy);
      const proxyName =
        originalIndex >= 0 ? proxyNames[originalIndex] : `Proxy${i + 1}`;

      try {
        console.log(`Trying service через ${proxyName}: ${serviceUrl}`);

        // Используем HttpsProxyAgent если доступен
        let fetchOptions: RequestInit = {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          },
          signal: AbortSignal.timeout(15000),
        };

        // Пробуем использовать прокси через переменные окружения для fetch
        // В Node.js 18+ fetch не поддерживает прокси напрямую, используем curl
        const curlArgs = ["-L", "--proxy", proxy, serviceUrl];
        const curlOutput = await new Promise<string>((resolve, reject) => {
          const curl = spawn("curl", curlArgs);
          let output = "";
          curl.stdout.on("data", (data: Buffer) => (output += data.toString()));
          curl.stderr.on("data", (data: Buffer) => {
            // Игнорируем stderr, если это не ошибка
          });
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
        // Продолжаем пробовать следующий прокси
        continue;
      }
    }

    // Если все прокси не сработали для этого сервиса, пробуем без прокси
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

  // Получаем список доступных прокси
  const availableProxies = await getAvailableProxies();
  const proxiesToTry = availableProxies.length > 0 ? availableProxies : PROXY_LIST;

  // Пробуем каждый доступный прокси по очереди (если вообще есть)
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
      // Продолжаем пробовать следующий прокси
      continue;
    }
  }

  // Всегда пробуем без прокси как последний шаг
  try {
    console.log("Пробуем скачать видео без прокси (curl без --proxy)...");
    await run("curl", ["-L", "-o", outPath, videoUrl]);
    console.log("✅ Видео успешно скачано без прокси");
    return;
  } catch (e: any) {
    lastError = e;
  }

  // Если все не сработало, выбрасываем ошибку
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

  const args = [
    "-y",
    "-i",
    inFile,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
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
  const data = job.data as any;
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
      job.data as any;
    const started = Date.now();
    const id = randomUUID();
    const raw = path.join(TMP_DIR, `${id}.mp4`);
    const out = path.join(TMP_DIR, `${id}.out.mp4`);

    console.log(`Processing job ${job.id}: ${url}`);

    try {
      const expandedUrl = await expandUrl(url);
      const result = await ytDownload(expandedUrl, raw);

      if (result.type === "images") {
        console.log(`Processing photo post with ${result.data.length} images`);
        const imageUrls = result.data as string[];
        const downloadedImages = await downloadImages(imageUrls);

        if (downloadedImages.length > 0) {
          await sendImagesInBatches(
            chatId,
            downloadedImages,
            messageId,
            ackMessageId
          );

          await recordStat(buildStatPayload(job, started, "success", 0));

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

        await recordStat(buildStatPayload(job, started, "compressed", bytes));
        return;
      }

      await bot.api.sendChatAction(chatId, "upload_video");
      await bot.api.sendVideo(chatId, new InputFile(videoPath), {
        reply_to_message_id: messageId,
      });
      await bot.api.deleteMessage(chatId, ackMessageId).catch(() => {});

      await recordStat(buildStatPayload(job, started, "success", bytes));
    } catch (e: any) {
      console.error(`Job ${job.id} failed:`, e);
      await bot.api.editMessageText(
        chatId,
        ackMessageId,
        `❌ Ошибка: ${e.message || e}`
      );
      await recordStat(
        buildStatPayload(job, started, "failed", 0, String(e.message || e).slice(0, 500))
      );
      throw e;
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

console.log("🔧 Worker started successfully");
console.log(`📊 Concurrency: ${process.env.MAX_CONCURRENCY || "2"}`);
console.log(`📏 Size limit: ${SIZE_LIMIT_MB} MB`);
console.log(
  `🌐 Proxies: Shadowsocks=${YTDLP_PROXY_SHADOWSOCKS}, Hysteria2=${YTDLP_PROXY_HYSTERIA2}, VLESS=${YTDLP_PROXY_VLESS}`
);

