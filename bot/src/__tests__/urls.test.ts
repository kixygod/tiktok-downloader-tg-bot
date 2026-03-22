import { describe, it, expect } from "vitest";
import { extractSupportedUrls } from "../urls";

describe("extractSupportedUrls", () => {
  it("извлекает TikTok ссылки", () => {
    const text = "Смотри https://www.tiktok.com/@user/video/123";
    const result = extractSupportedUrls(text);
    expect(result).toHaveLength(1);
    expect(result[0].url).toContain("tiktok.com");
    expect(result[0].platform).toBe("tiktok");
  });

  it("извлекает короткие TikTok ссылки vm.tiktok.com", () => {
    const text = "https://vm.tiktok.com/abc123/";
    const result = extractSupportedUrls(text);
    expect(result).toHaveLength(1);
    expect(result[0].platform).toBe("tiktok");
  });

  it("извлекает YouTube Shorts", () => {
    const text = "https://www.youtube.com/shorts/xyz789";
    const result = extractSupportedUrls(text);
    expect(result).toHaveLength(1);
    expect(result[0].platform).toBe("youtube");
  });

  it("извлекает VK Clips", () => {
    const text = "https://vk.com/clip-123456789_123456";
    const result = extractSupportedUrls(text);
    expect(result).toHaveLength(1);
    expect(result[0].platform).toBe("vk");
  });

  it("извлекает Instagram Reels", () => {
    const text = "https://www.instagram.com/reel/ABC123xyz/";
    const result = extractSupportedUrls(text);
    expect(result).toHaveLength(1);
    expect(result[0].platform).toBe("instagram");
  });

  it("извлекает Instagram посты (p/)", () => {
    const text = "https://www.instagram.com/p/ABC123xyz/";
    const result = extractSupportedUrls(text);
    expect(result).toHaveLength(1);
    expect(result[0].platform).toBe("instagram");
  });

  it("извлекает X/Twitter (x.com …/status/id)", () => {
    const text = "Ссылка https://x.com/user/status/1234567890123456789";
    const result = extractSupportedUrls(text);
    expect(result).toHaveLength(1);
    expect(result[0].url).toContain("x.com");
    expect(result[0].platform).toBe("twitter");
  });

  it("извлекает twitter.com и mobile.twitter.com", () => {
    const a = extractSupportedUrls("https://twitter.com/foo/status/1");
    expect(a[0]?.platform).toBe("twitter");
    const b = extractSupportedUrls("https://mobile.twitter.com/bar/status/99?s=20");
    expect(b[0]?.platform).toBe("twitter");
    expect(b[0]?.url).toContain("s=20");
  });

  it("извлекает короткие t.co", () => {
    const text = "https://t.co/AbCd12";
    const result = extractSupportedUrls(text);
    expect(result).toHaveLength(1);
    expect(result[0].platform).toBe("twitter");
  });

  it("извлекает /i/web/status/", () => {
    const text = "https://twitter.com/i/web/status/1234567890";
    const result = extractSupportedUrls(text);
    expect(result).toHaveLength(1);
    expect(result[0].platform).toBe("twitter");
  });

  it("убирает дубликаты", () => {
    const text = "https://tiktok.com/@u/video/1 https://tiktok.com/@u/video/1";
    const result = extractSupportedUrls(text);
    expect(result).toHaveLength(1);
  });

  it("возвращает пустой массив для неподдерживаемых ссылок", () => {
    const text = "https://example.com/video";
    const result = extractSupportedUrls(text);
    expect(result).toHaveLength(0);
  });

  it("извлекает несколько ссылок разных платформ", () => {
    const text =
      "https://tiktok.com/@u/v/1 https://youtube.com/shorts/2 https://instagram.com/reel/3";
    const result = extractSupportedUrls(text);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});
