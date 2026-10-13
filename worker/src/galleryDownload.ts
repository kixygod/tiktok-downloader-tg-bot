import { runProcess } from "./process";

export type GalleryDlPlatform =
  | "bluesky"
  | "facebook"
  | "flickr"
  | "instagram"
  | "pinterest"
  | "reddit"
  | "tumblr"
  | "vk";

function isPrivateHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      host.endsWith(".internal") || host.endsWith(".home.arpa") || host.includes(":")) return true;
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4) {
    const [a, b, c] = ipv4.slice(1).map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && b === 0 && (c === 0 || c === 2 || c === 88)) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113);
  }
  return false;
}

export function galleryDlPlatform(rawUrl: string): GalleryDlPlatform | null {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return null; }
  if (url.protocol !== "https:" || url.username || url.password || isPrivateHostname(url.hostname)) return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname;

  if (host === "bsky.app" && /^\/profile\/[^/]+\/post\/[a-z0-9]+$/i.test(path)) return "bluesky";
  if ((host === "reddit.com" || ["www.reddit.com", "old.reddit.com", "new.reddit.com"].includes(host)) &&
      (/^\/r\/[^/]+\/comments\/[a-z0-9]+(?:\/[^/]*)?\/?$/i.test(path) || /^\/gallery\/[a-z0-9]+\/?$/i.test(path))) return "reddit";
  if (host === "redd.it" && /^\/[a-z0-9]+\/?$/i.test(path)) return "reddit";
  if ((host === "pinterest.com" || host === "www.pinterest.com") && /^\/pin\/\d+\/?$/i.test(path)) return "pinterest";
  if (host === "pin.it" && /^\/[a-z0-9]+\/?$/i.test(path)) return "pinterest";
  if ((host === "flickr.com" || host === "www.flickr.com") && /^\/photos\/[^/]+\/\d+\/?$/i.test(path)) return "flickr";
  if (host === "flic.kr" && /^\/p\/[a-z0-9]+\/?$/i.test(path)) return "flickr";
  if ((host === "instagram.com" || host === "www.instagram.com") && /^\/(?:p|reel|tv)\/[a-z0-9_-]+\/?$/i.test(path)) return "instagram";
  if ((host === "tumblr.com" || host === "www.tumblr.com") && /^\/[^/]+\/\d+(?:\/[^/]*)?\/?$/i.test(path)) return "tumblr";
  if (/^[a-z0-9-]+\.tumblr\.com$/i.test(host) && /^\/post\/\d+(?:\/[^/]*)?\/?$/i.test(path)) return "tumblr";
  if (["facebook.com", "www.facebook.com", "m.facebook.com"].includes(host) &&
      ((path.toLowerCase() === "/photo.php" && /^\d+$/.test(url.searchParams.get("fbid") || "")) ||
       /^\/[^/]+\/(?:posts|photos)\/[^/]+\/?$/i.test(path) ||
       (path.toLowerCase() === "/permalink.php" && /^\d+$/.test(url.searchParams.get("story_fbid") || "")))) return "facebook";
  if (host === "vk.com" && /^\/(?:photo-?\d+_\d+|wall-?\d+_\d+|album-?\d+_\d+)\/?$/i.test(path)) return "vk";
  return null;
}

const IMAGE_FILTER = "extension.lower() in ('jpg', 'jpeg', 'png', 'webp', 'gif', 'avif', 'heic', 'heif', 'bmp', 'tif', 'tiff')";
const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "heic", "heif", "bmp", "tif", "tiff"]);
const NON_IMAGE_EXTENSIONS = new Set(["avi", "flv", "m4a", "m4v", "mkv", "mov", "mp3", "mp4", "mpeg", "mpg", "pdf", "wav", "webm", "wmv", "zip"]);
const MAX_GALLERY_IMAGES = 10;

export function galleryDlArgs(url: string): string[] {
  if (!galleryDlPlatform(url)) throw new Error("Unsupported gallery-dl URL");
  return [
    "--config-ignore", "--no-input", "--quiet", "--no-mtime",
    "--http-timeout", "15", "--retries", "1",
    "--range", `1-${MAX_GALLERY_IMAGES}`,
    "--filesize-max", "5M", "--filter", IMAGE_FILTER,
    "--get-urls", url,
  ];
}

export function parseGalleryDlImageUrls(output: string): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw || seen.has(raw)) continue;
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    const fileName = url.pathname.split("/").pop() || "";
    const extensionSeparator = fileName.lastIndexOf(".");
    const extension = extensionSeparator > 0
      ? fileName.slice(extensionSeparator + 1).toLowerCase()
      : "";
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
        url.port && !["80", "443"].includes(url.port) || isPrivateHostname(url.hostname) ||
        extension && !IMAGE_EXTENSIONS.has(extension) && NON_IMAGE_EXTENSIONS.has(extension)) continue;
    seen.add(raw);
    urls.push(raw);
    if (urls.length >= MAX_GALLERY_IMAGES) break;
  }
  return urls;
}

export async function getGalleryDlImageUrls(url: string): Promise<string[]> {
  const args = galleryDlArgs(url);
  const { stdout } = await runProcess("gallery-dl", args, { timeoutMs: 90000, maxOutputBytes: 128 * 1024 });
  return parseGalleryDlImageUrls(stdout);
}
