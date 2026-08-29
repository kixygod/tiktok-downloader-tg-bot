import { describe, it, expect } from "vitest";
import { isYouTubeUrl, ytdlpFormatArgs } from "../ytdlpFormat";

describe("isYouTubeUrl", () => {
  it("распознаёт shorts и youtu.be", () => {
    expect(isYouTubeUrl("https://youtube.com/shorts/_PEBrtlEr6Y")).toBe(true);
    expect(isYouTubeUrl("https://www.youtube.com/shorts/abc")).toBe(true);
    expect(isYouTubeUrl("https://m.youtube.com/shorts/abc")).toBe(true);
    expect(isYouTubeUrl("https://youtu.be/abc123")).toBe(true);
  });

  it("не считает TikTok ютубом", () => {
    expect(isYouTubeUrl("https://www.tiktok.com/@u/video/1")).toBe(false);
    expect(isYouTubeUrl("https://vt.tiktok.com/xxx/")).toBe(false);
  });
});

describe("ytdlpFormatArgs", () => {
  it("для YouTube склеивает видео+аудио в mp4", () => {
    const args = ytdlpFormatArgs("https://youtube.com/shorts/_PEBrtlEr6Y");
    expect(args).toContain("-f");
    expect(args).toContain("--merge-output-format");
    expect(args).toContain("mp4");
    expect(args[1]).toContain("bestvideo");
    expect(args[1]).toContain("bestaudio");
  });

  it("для TikTok оставляет progressive mp4 без merge", () => {
    const args = ytdlpFormatArgs("https://www.tiktok.com/@u/video/1");
    expect(args).toEqual([
      "-f",
      "best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best",
    ]);
  });
});
