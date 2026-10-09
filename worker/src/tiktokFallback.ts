import { extractTikTokItemId, TIKTOK_WEB_UA } from "./tiktokPhotos";

export type TikTokFallbackService = "tikwm" | "tikmate";
export type TikTokFallbackMedia = { type: "video"; data: string } | { type: "images"; data: string[] };

export function tikTokFallbackRequests(url: string): Array<{
  service: TikTokFallbackService;
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}> {
  return [
    { service: "tikwm", url: `https://tikwm.com/api/?url=${encodeURIComponent(url)}`, method: "GET", headers: { "User-Agent": TIKTOK_WEB_UA } },
    {
      service: "tikmate", url: "https://api.tikmate.app/api/lookup", method: "POST",
      headers: { "User-Agent": TIKTOK_WEB_UA, "Content-Type": "application/x-www-form-urlencoded", Referer: "https://tikmate.app/" },
      body: new URLSearchParams({ url }).toString(),
    },
  ];
}

export function parseTikTokFallbackMedia(service: TikTokFallbackService, payload: unknown, url: string): TikTokFallbackMedia {
  const data = payload as any;
  if (service === "tikmate") {
    const expectedId = extractTikTokItemId(url);
    if (data?.success !== true || typeof data.id !== "string" || !/^\d{8,}$/.test(data.id) ||
        (expectedId && expectedId !== data.id) || typeof data.token !== "string" || !data.token.trim() || data.token.length > 4096) {
      throw new Error("Tikmate: no matching media returned");
    }
    return { type: "video", data: `https://tikmate.app/download/${encodeURIComponent(data.token)}/${data.id}.mp4` };
  }

  if (data?.code !== 0) throw new Error("Tikwm: no media returned");
  const isHttpUrl = (value: unknown): value is string => {
    if (typeof value !== "string") return false;
    try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; }
  };
  if (Array.isArray(data.data?.images) && data.data.images.length > 0) {
    if (!data.data.images.every(isHttpUrl)) throw new Error("Tikwm: incomplete photo album");
    return { type: "images", data: data.data.images };
  }
  const video = data.data?.hdplay || data.data?.play || data.video;
  if (!isHttpUrl(video)) throw new Error("Tikwm: no video URL returned");
  return { type: "video", data: video };
}

export function parseSssTikMedia(html: string): TikTokFallbackMedia {
  const images: string[] = [];
  const videos: string[] = [];
  for (const match of html.matchAll(/<a\b[^>]*>/gi)) {
    const attributes = Object.fromEntries(Array.from(match[0].matchAll(/\b([\w-]+)\s*=\s*(["'])(.*?)\2/gs), m => [m[1].toLowerCase(), m[3]]));
    const classes = (attributes.class || "").split(/\s+/);
    if (!classes.includes("download_link")) continue;
    const slide = classes.includes("slide");
    if (!slide && !classes.includes("without_watermark")) continue;
    const address = (attributes.href || "").replace(/&amp;/g, "&").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
    let parsed: URL;
    try { parsed = new URL(address); } catch { throw new Error("SSSTik: incomplete media response"); }
    if (parsed.protocol !== "https:" || !(parsed.hostname === "tikcdn.io" || parsed.hostname.endsWith(".tikcdn.io")) || parsed.username || parsed.password) {
      throw new Error("SSSTik: unexpected media host");
    }
    (slide ? images : videos).push(address);
  }
  if (images.length > 0) return { type: "images", data: images };
  if (videos.length > 0) return { type: "video", data: videos[0] };
  throw new Error("SSSTik: no media returned");
}

export async function fetchSssTikMedia(url: string, fetcher: (url: string, options: RequestInit) => Promise<Response> = fetch): Promise<TikTokFallbackMedia> {
  const headers = { "User-Agent": TIKTOK_WEB_UA, Referer: "https://ssstik.io/en" };
  const readText = async (address: string, options: RequestInit): Promise<string> => {
    const response = await fetcher(address, { ...options, credentials: "omit", signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`SSSTik: HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("SSSTik: empty response");
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new Error("SSSTik: response too large");
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    return Buffer.concat(chunks).toString("utf8");
  };
  const page = await readText("https://ssstik.io/en", { headers });
  const token = page.match(/\bs_tt\s*=\s*["']([^"']{1,4096})["']/)?.[1];
  if (!token) throw new Error("SSSTik: guest form token missing");
  const html = await readText("https://ssstik.io/abc?url=dl", {
    method: "POST", headers: { ...headers, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ id: url, locale: "en", tt: token }).toString(),
  });
  return parseSssTikMedia(html);
}
