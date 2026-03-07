import type { ExtractedUrl } from "./types";

export const SUPPORTED_URL_PATTERNS: { pattern: RegExp; platform: string }[] = [
  {
    pattern: /(https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/[^\s]+)/gi,
    platform: "tiktok",
  },
  {
    pattern: /(https?:\/\/(?:www\.)?youtube\.com\/shorts\/[^\s]+)/gi,
    platform: "youtube",
  },
  {
    pattern: /(https?:\/\/(?:www\.)?vk\.com\/clip-[^\s]+)/gi,
    platform: "vk",
  },
  {
    pattern: /(https?:\/\/(?:www\.)?instagram\.com\/reel\/[^\s]+)/gi,
    platform: "instagram",
  },
  {
    pattern: /(https?:\/\/(?:www\.)?instagram\.com\/p\/[^\s]+)/gi,
    platform: "instagram",
  },
];

export function extractSupportedUrls(text: string): ExtractedUrl[] {
  const seen = new Set<string>();
  const result: ExtractedUrl[] = [];
  for (const { pattern, platform } of SUPPORTED_URL_PATTERNS) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const url = m[0].trim();
      if (!seen.has(url)) {
        seen.add(url);
        result.push({ url, platform });
      }
    }
  }
  return result;
}
