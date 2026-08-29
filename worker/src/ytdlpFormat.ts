/** YouTube отдаёт видео и звук отдельными дорожками — progressive mp4 часто нет. */
const YOUTUBE_FORMAT =
  "bestvideo[vcodec^=avc1][height<=1080]+bestaudio[ext=m4a]/bestvideo[height<=1080]+bestaudio/best";

/** TikTok/остальные: один готовый mp4, без склейки. */
const DEFAULT_FORMAT = "best[ext=mp4][vcodec^=avc1]/best[ext=mp4]/best";

export function isYouTubeUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    return h === "youtube.com" || h === "m.youtube.com" || h === "youtu.be";
  } catch {
    return /youtube\.com|youtu\.be/i.test(url);
  }
}

export function ytdlpFormatArgs(url: string): string[] {
  if (isYouTubeUrl(url)) {
    return ["-f", YOUTUBE_FORMAT, "--merge-output-format", "mp4"];
  }
  return ["-f", DEFAULT_FORMAT];
}
