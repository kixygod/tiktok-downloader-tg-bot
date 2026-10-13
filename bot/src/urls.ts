import type { ExtractedUrl } from "./types";

export const SUPPORTED_URL_PATTERNS: { pattern: RegExp; platform: string }[] = [
  {
    pattern: /(https?:\/\/(?:www\.|vm\.|vt\.)?tiktok\.com\/[^\s]+)/gi,
    platform: "tiktok",
  },
  {
    pattern: /(https?:\/\/(?:www\.)?bsky\.app\/profile\/[^/\s]+\/post\/[a-zA-Z0-9]+[^\s]*)/gi,
    platform: "bluesky",
  },
  {
    pattern: /(https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/(?:r\/[^/\s]+\/comments\/[a-zA-Z0-9]+(?:\/[^\s]*)?|gallery\/[a-zA-Z0-9]+[^\s]*))/gi,
    platform: "reddit",
  },
  {
    pattern: /(https?:\/\/redd\.it\/[a-zA-Z0-9]+[^\s]*)/gi,
    platform: "reddit",
  },
  {
    pattern: /(https?:\/\/(?:www\.)?pinterest\.com\/pin\/[0-9]+[^\s]*)/gi,
    platform: "pinterest",
  },
  {
    pattern: /(https?:\/\/pin\.it\/[a-zA-Z0-9]+[^\s]*)/gi,
    platform: "pinterest",
  },
  {
    pattern: /(https?:\/\/(?:www\.)?flickr\.com\/photos\/[^/\s]+\/[0-9]+[^\s]*)/gi,
    platform: "flickr",
  },
  {
    pattern: /(https?:\/\/flic\.kr\/p\/[a-zA-Z0-9]+[^\s]*)/gi,
    platform: "flickr",
  },
  {
    pattern: /(https?:\/\/(?:www\.)?tumblr\.com\/[^/\s]+\/[0-9]+[^\s]*)/gi,
    platform: "tumblr",
  },
  {
    pattern: /(https?:\/\/[a-zA-Z0-9-]+\.tumblr\.com\/post\/[0-9]+[^\s]*)/gi,
    platform: "tumblr",
  },
  {
    pattern: /(https?:\/\/(?:www\.|m\.)?facebook\.com\/(?:photo\.php\?[^\s]*fbid=[0-9]+[^\s]*|[^/\s]+\/(?:posts|photos)\/[^\s]+|permalink\.php\?[^\s]*story_fbid=[0-9]+[^\s]*))/gi,
    platform: "facebook",
  },
  {
    pattern: /(https?:\/\/(?:www\.)?vk\.com\/(?:photo-?\d+_\d+|wall-?\d+_\d+|album-?\d+_\d+)[^\s]*)/gi,
    platform: "vk",
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
    pattern: /(https?:\/\/(?:www\.)?instagram\.com\/(?:reel|tv)\/[^\s]+)/gi,
    platform: "instagram",
  },
  {
    pattern: /(https?:\/\/(?:www\.)?instagram\.com\/p\/[^\s]+)/gi,
    platform: "instagram",
  },
  {
    // twitter.com / x.com / mobile — посты и видео (/user/status/, /i/status/)
    pattern:
      /(https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/(?:[^/\s]+\/)?status\/\d+[^\s]*)/gi,
    platform: "twitter",
  },
  {
    // веб-шаринг: /i/web/status/123
    pattern:
      /(https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com)\/i\/web\/status\/\d+[^\s]*)/gi,
    platform: "twitter",
  },
  {
    pattern: /(https?:\/\/t\.co\/[a-zA-Z0-9]+)/gi,
    platform: "twitter",
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
