import { renameSync, rmSync } from "node:fs";
import { runProcess } from "./process";

const MAX_IMAGE_EDGE = 4000;
const TELEGRAM_MAX_SIDE_SUM = 10000;

interface ImageStream {
  codec_name?: string;
  width?: number;
  height?: number;
}

async function inspectImage(file: string): Promise<ImageStream | null> {
  const { stdout } = await runProcess(
    "ffprobe",
    [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,width,height",
      "-of", "json",
      file,
    ],
    { timeoutMs: 10000 },
  );
  const streams = (JSON.parse(stdout) as { streams?: ImageStream[] }).streams;
  return streams?.[0] ?? null;
}

function isTelegramPhoto(stream: ImageStream | null): boolean {
  if (stream?.codec_name !== "mjpeg") return false;
  const width = Number(stream.width);
  const height = Number(stream.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
    return false;
  }
  return (
    width + height < TELEGRAM_MAX_SIDE_SUM &&
    width / height <= 20 &&
    height / width <= 20
  );
}

export async function normalizeImageForTelegram(file: string): Promise<void> {
  const stream = await inspectImage(file);
  if (isTelegramPhoto(stream)) return;

  const converted = `${file}.converted.jpg`;
  const filter = [
    `[0:v:0]scale=w='min(iw,${MAX_IMAGE_EDGE})':h='min(ih,${MAX_IMAGE_EDGE})':force_original_aspect_ratio=decrease:force_divisible_by=2[foreground]`,
    "color=c=white:s=1x1[background]",
    "[background][foreground]scale2ref[background_scaled][foreground_scaled]",
    "[background_scaled][foreground_scaled]overlay=shortest=1:format=auto,format=yuvj420p[out]",
  ].join(";");

  try {
    await runProcess(
      "ffmpeg",
      [
        "-v", "error",
        "-nostdin",
        "-y",
        "-i", file,
        "-filter_complex", filter,
        "-map", "[out]",
        "-frames:v", "1",
        "-q:v", "3",
        "-pix_fmt", "yuvj420p",
        "-f", "image2",
        converted,
      ],
      { timeoutMs: 20000 },
    );
    renameSync(converted, file);
  } finally {
    rmSync(converted, { force: true });
  }
}
