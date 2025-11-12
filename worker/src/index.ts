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
const YTDLP_PROXY = process.env.YTDLP_PROXY; // http://xray:10809

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
  // Разворачиваем vm.tiktok.com, vt.tiktok.com и tiktok.com/t/... в полный линк
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
  const args = [
    "-f",
    "bv*+ba/b",
    "--no-warnings",
    "--no-progress",
    "--restrict-filenames",
    "--no-playlist",
    "-o",
    outPath,
    url,
  ];
  if (YTDLP_PROXY) {
    args.unshift("--proxy", YTDLP_PROXY);
  }

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
    return { type: "video", data: finalPath };
  } catch (e) {
    console.log("yt-dlp failed, trying alternative methods...");
    // Попробуем альтернативные методы
    return await tryAlternativeDownload(url, outPath);
  }
}

async function downloadImages(imageUrls: string[]): Promise<string[]> {
  const downloadedImages: string[] = [];

  for (let i = 0; i < imageUrls.length; i++) {
    const imageUrl = imageUrls[i];
    const imagePath = path.join(TMP_DIR, `image_${i}.jpg`);

    try {
      console.log(
        `Downloading image ${i + 1}/${imageUrls.length}: ${imageUrl}`
      );
      const args = ["-L", "-o", imagePath, imageUrl];
      if (YTDLP_PROXY) {
        args.unshift("--proxy", YTDLP_PROXY);
      }
      await run("curl", args);
      downloadedImages.push(imagePath);
    } catch (e) {
      console.log(`Failed to download image ${i + 1}: ${e}`);
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
  const batchSize = 10; // Telegram максимум 10 фото в сообщении

  for (let i = 0; i < images.length; i += batchSize) {
    const batch = images.slice(i, i + batchSize);

    try {
      await bot.api.sendChatAction(chatId, "upload_photo");

      if (batch.length === 1) {
        // Одна картинка
        await bot.api.sendPhoto(chatId, new InputFile(batch[0]), {
          reply_to_message_id: messageId,
        });
      } else {
        // Несколько картинок
        const media = batch.map((img) => ({
          type: "photo" as const,
          media: new InputFile(img),
        }));

        await bot.api.sendMediaGroup(chatId, media, {
          reply_to_message_id: messageId,
        });
      }

      // Небольшая пауза между батчами
      if (i + batchSize < images.length) {
        await sleep(1000);
      }
    } catch (e) {
      console.log(
        `Failed to send batch ${Math.floor(i / batchSize) + 1}: ${e}`
      );
    }
  }

  // Удаляем сообщение "Обрабатываю"
  await bot.api.deleteMessage(chatId, ackMessageId).catch(() => {});
}

async function tryAlternativeDownload(
  url: string,
  outPath: string
): Promise<{ type: "video" | "images"; data: string | string[] }> {
  // Используем curl для загрузки через альтернативные сервисы
  const services = [
    `https://tikwm.com/api/?url=${encodeURIComponent(url)}`,
    `https://api.tikmate.app/api/lookup?id=${
      url.split("/").pop()?.split("?")[0]
    }`,
  ];

  for (const serviceUrl of services) {
    try {
      console.log(`Trying service: ${serviceUrl}`);
      const response = await fetch(serviceUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) continue;

      const data = (await response.json()) as any;

      // Проверяем на фото-пост
      if (data.data?.images && Array.isArray(data.data.images)) {
        console.log(`Found photo post with ${data.data.images.length} images`);
        return { type: "images", data: data.data.images };
      }

      // Проверяем на видео
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
      console.log(`Service failed: ${e}`);
      continue;
    }
  }

  throw new Error("All download methods failed");
}

async function downloadVideo(videoUrl: string, outPath: string): Promise<void> {
  const args = ["-L", "-o", outPath, videoUrl];
  if (YTDLP_PROXY) {
    args.unshift("--proxy", YTDLP_PROXY);
  }
  await run("curl", args);
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
  // Возьмём ~6% запас на контейнер/оверрид
  const usable = Math.floor(targetBytes * 0.94);
  // Простейший расчёт битрейта: (usable bytes * 8) / seconds
  const seconds = Math.max(1, Math.round(durMs / 1000));
  // Аудио 96k, остальное видео
  const audioK = 96_000;
  const totalBitrate = Math.max(180_000, Math.floor((usable * 8) / seconds)); // не ниже 180k
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
    // Отправляем статистику на бот через HTTP
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
        // Обработка фото-поста
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

          await recordStat({
            ts: started,
            url,
            status: "success",
            bytes: 0, // Для изображений не считаем байты
            duration_ms: Date.now() - started,
            chat_id: chatId,
          });

          // Очищаем загруженные изображения
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

      // Обработка видео
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
        // Одна попытка пережатия
        await recompressToTarget(videoPath, out, MAX_BYTES);
        bytes = statSync(out).size;
        console.log(`After compression: ${bytes} bytes`);

        if (bytes > MAX_BYTES) {
          await bot.api.editMessageText(
            chatId,
            ackMessageId,
            `❌ Не могу уложиться в ${SIZE_LIMIT_MB} MB даже после сжатия. Попробуйте другую ссылку.`
          );
          await recordStat({
            ts: started,
            url,
            status: "too_large",
            bytes,
            duration_ms: Date.now() - started,
            chat_id: chatId,
          });
          return;
        }

        // заменяем файл
        try {
          rmSync(videoPath, { force: true });
        } catch {}

        await bot.api.sendChatAction(chatId, "upload_video");
        await bot.api.sendVideo(chatId, new InputFile(out), {
          reply_to_message_id: messageId,
        });
        await bot.api.deleteMessage(chatId, ackMessageId).catch(() => {});

        await recordStat({
          ts: started,
          url,
          status: "compressed",
          bytes,
          duration_ms: Date.now() - started,
          chat_id: chatId,
        });
        return;
      }

      // Уже в лимите
      await bot.api.sendChatAction(chatId, "upload_video");
      await bot.api.sendVideo(chatId, new InputFile(videoPath), {
        reply_to_message_id: messageId,
      });
      await bot.api.deleteMessage(chatId, ackMessageId).catch(() => {});

      await recordStat({
        ts: started,
        url,
        status: "success",
        bytes,
        duration_ms: Date.now() - started,
        chat_id: chatId,
      });
    } catch (e: any) {
      console.error(`Job ${job.id} failed:`, e);
      await bot.api.editMessageText(
        chatId,
        ackMessageId,
        `❌ Ошибка: ${e.message || e}`
      );
      await recordStat({
        ts: started,
        url,
        status: "failed",
        bytes: 0,
        duration_ms: Date.now() - started,
        chat_id: chatId,
      });
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
console.log(`🌐 Proxy: ${YTDLP_PROXY || "none"}`);
