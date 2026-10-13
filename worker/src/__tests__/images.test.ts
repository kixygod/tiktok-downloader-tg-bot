import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProcess } from "../process";
import { normalizeImageForTelegram } from "../images";

const directories: string[] = [];
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tiktok-images-"));
  directories.push(dir);
  return path.join(dir, "photo.jpg");
};
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("Telegram photo normalization (requires ffmpeg/ffprobe)", () => {
  it("converts WebP disguised as .jpg to JPEG and preserves dimensions", async () => {
    const file = fixture();
    await runProcess("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=red:s=16x16", "-frames:v", "1", "-c:v", "libwebp", "-f", "webp", file]);
    expect(readFileSync(file).toString("ascii", 8, 12)).toBe("WEBP");
    await normalizeImageForTelegram(file);
    const { stdout } = await runProcess("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,width,height", "-of", "json", file]);
    expect(JSON.parse(stdout).streams[0]).toEqual({ codec_name: "mjpeg", width: 16, height: 16 });
    const jpeg = readFileSync(file);
    await normalizeImageForTelegram(file);
    expect(readFileSync(file)).toEqual(jpeg);
    expect(readdirSync(path.dirname(file))).toEqual(["photo.jpg"]);
  });

  it("converts oversized PNG images into Telegram-compatible JPEGs", async () => {
    const file = fixture();
    await runProcess("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=6000x4000",
      "-frames:v", "1", "-vcodec", "png", "-y", file,
    ]);
    await normalizeImageForTelegram(file);
    const { stdout } = await runProcess("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=codec_name,width,height", "-of", "json", file,
    ]);
    const image = JSON.parse(stdout).streams[0];
    expect(image.codec_name).toBe("mjpeg");
    expect(image.width).toBeLessThanOrEqual(4000);
    expect(image.height).toBeLessThanOrEqual(4000);
    expect(image.width + image.height).toBeLessThan(10000);
    expect(readFileSync(file).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  });

  it("scales a 5000×5000 JPEG below Telegram's strict side-sum limit", async () => {
    const file = fixture();
    await runProcess("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=5000x5000",
      "-frames:v", "1", "-q:v", "2", "-y", file,
    ]);
    await normalizeImageForTelegram(file);
    const { stdout } = await runProcess("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=codec_name,width,height", "-of", "json", file,
    ]);
    const image = JSON.parse(stdout).streams[0];
    expect(image.width + image.height).toBeLessThan(10000);
  });

  it("keeps a valid 5000×4999 JPEG under the strict side-sum limit", async () => {
    const file = fixture();
    await runProcess("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=5000x4999",
      "-frames:v", "1", "-q:v", "2", "-y", file,
    ]);
    await normalizeImageForTelegram(file);
    const { stdout } = await runProcess("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries",
      "stream=codec_name,width,height", "-of", "json", file,
    ]);
    const image = JSON.parse(stdout).streams[0];
    expect(image.width).toBe(5000);
    expect(image.height).toBe(4999);
    expect(image.width + image.height).toBeLessThan(10000);
  });

  it("composites transparent sources on white instead of black", async () => {
    const file = fixture();
    const pixelFile = path.join(path.dirname(file), "pixel.ppm");
    await runProcess("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "color=c=red:s=16x16",
      "-frames:v", "1", "-vf", "format=rgba,colorchannelmixer=aa=0",
      "-vcodec", "png", "-y", file,
    ]);
    await normalizeImageForTelegram(file);
    await runProcess("ffmpeg", [
      "-v", "error", "-i", file, "-frames:v", "1", "-vf", "scale=1:1",
      "-vcodec", "ppm", "-y", pixelFile,
    ]);
    const pixel = readFileSync(pixelFile).subarray(-3);
    expect([...pixel].every((channel) => channel >= 240)).toBe(true);
  });

  it("rejects corrupted WebP without replacing the source or leaving temporary files", async () => {
    const file = fixture();
    const corrupt = Buffer.from("RIFFxxxxWEBPinvalid");
    writeFileSync(file, corrupt);
    await expect(normalizeImageForTelegram(file)).rejects.toThrow();
    expect(readFileSync(file)).toEqual(corrupt);
    expect(readdirSync(path.dirname(file))).toEqual(["photo.jpg"]);
  });
});
