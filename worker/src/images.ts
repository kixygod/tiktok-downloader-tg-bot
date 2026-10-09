import { openSync, readSync, closeSync, renameSync, rmSync } from "node:fs";
import { runProcess } from "./process";

export async function normalizeImageForTelegram(file: string): Promise<void> {
  const header = Buffer.alloc(12);
  const fd = openSync(file, "r");
  try { readSync(fd, header, 0, header.length, 0); } finally { closeSync(fd); }
  if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WEBP") return;
  const converted = `${file}.converted.jpg`;
  try {
    await runProcess("ffmpeg", ["-v", "error", "-nostdin", "-y", "-i", file, "-frames:v", "1", "-q:v", "2", converted], { timeoutMs: 15000 });
    renameSync(converted, file);
  } finally { rmSync(converted, { force: true }); }
}
