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

  it("preserves PNG bytes", async () => {
    const file = fixture();
    const png = Buffer.from("89504e470d0a1a0a00000000", "hex");
    writeFileSync(file, png);
    await normalizeImageForTelegram(file);
    expect(readFileSync(file)).toEqual(png);
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
