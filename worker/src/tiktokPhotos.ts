export const TIKTOK_WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export function extractTikTokItemId(url: string): string | null {
  const fromPath = url.match(/\/(?:photo|video)\/(\d{8,})/i);
  if (fromPath) return fromPath[1];
  const trailing = url.match(/\/(\d{15,})(?:[/?#]|$)/);
  return trailing ? trailing[1] : null;
}

export function isTikTokPhotoUrl(url: string): boolean {
  try {
    return /\/photo\/\d+/i.test(new URL(url).pathname);
  } catch {
    return /\/photo\/\d+/i.test(url);
  }
}

function photomodeDedupeKey(url: string): string {
  const m = url.match(/\/([a-f0-9]{16,})~tplv-photomode/i);
  return m ? m[1].toLowerCase() : url.split("?")[0];
}

function isLikelyPhotoCdnUrl(url: string): boolean {
  const u = url.toLowerCase();
  return (
    u.includes("photomode") ||
    u.includes("tplv-photomode") ||
    /tos-[a-z0-9-]+-i-photomode/i.test(url)
  );
}

function extractBalancedJson(html: string, key: string): unknown | null {
  const re = new RegExp(`"${key}"\\s*:\\s*`);
  const hit = re.exec(html);
  if (!hit) return null;
  const start = hit.index + hit[0].length;
  const open = html[start];
  if (open !== "{" && open !== "[") return null;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function collectUrlLists(obj: unknown, out: string[]): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) collectUrlLists(item, out);
    return;
  }
  const rec = obj as Record<string, unknown>;
  if (Array.isArray(rec.urlList)) {
    const first = rec.urlList.find(
      (u): u is string => typeof u === "string" && /^https?:\/\//i.test(u),
    );
    if (first) out.push(first);
  }
  for (const value of Object.values(rec)) collectUrlLists(value, out);
}

function findNamedNodes(obj: unknown, keys: Set<string>, hits: unknown[]): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    for (const item of obj) findNamedNodes(item, keys, hits);
    return;
  }
  const rec = obj as Record<string, unknown>;
  for (const [k, v] of Object.entries(rec)) {
    if (keys.has(k)) hits.push(v);
    findNamedNodes(v, keys, hits);
  }
}

function dedupePhotoUrls(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of urls) {
    if (typeof raw !== "string" || !/^https?:\/\//i.test(raw)) continue;
    if (!isLikelyPhotoCdnUrl(raw)) continue;
    const key = photomodeDedupeKey(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

const PHOTO_JSON_KEYS = new Set([
  "imagePost",
  "imagePostInfo",
  "displayImages",
]);

/** Достаёт CDN-URL слайдов из HTML страницы / embed TikTok. */
export function parseTikTokImageUrlsFromHtml(html: string): string[] {
  const buckets: unknown[] = [];

  const universal = html.match(
    /id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i,
  );
  if (universal) {
    try {
      buckets.push(JSON.parse(universal[1]));
    } catch {
      /* битый JSON — идём в точечный разбор */
    }
  }

  for (const key of PHOTO_JSON_KEYS) {
    const node = extractBalancedJson(html, key);
    if (node) buckets.push({ [key]: node });
  }

  const collected: string[] = [];
  for (const bucket of buckets) {
    const focused: unknown[] = [];
    findNamedNodes(bucket, PHOTO_JSON_KEYS, focused);
    if (focused.length === 0) {
      collectUrlLists(bucket, collected);
    } else {
      for (const node of focused) collectUrlLists(node, collected);
    }
  }

  const fromJson = dedupePhotoUrls(collected);
  if (fromJson.length > 0) return fromJson;

  const loose: string[] = [];
  const re =
    /https?:(?:\\u002[fF]\\u002[fF]|\/\/)[^"'\\\s<>]+photomode-image\.jpe?g[^"'\\\s<>]*/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    loose.push(
      m[0]
        .replace(/\\u002[fF]/gi, "/")
        .replace(/\\u0026/g, "&")
        .replace(/\\\//g, "/"),
    );
  }
  return dedupePhotoUrls(loose);
}

export function tiktokPhotoCandidatePages(pageUrl: string): string[] {
  const id = extractTikTokItemId(pageUrl);
  const out: string[] = [];
  if (id) {
    out.push(`https://www.tiktok.com/embed/v2/${id}`);
    out.push(`https://www.tiktok.com/embed/${id}`);
  }
  if (/tiktok\.com/i.test(pageUrl) && !/\/embed\//i.test(pageUrl)) {
    out.push(pageUrl);
  }
  return [...new Set(out)];
}
