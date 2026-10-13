export function redact(text: string): string {
  return text
    .replace(/(api\.telegram\.org\/(?:file\/)?bot)\d+:[A-Za-z0-9_-]+/g, "$1[REDACTED_TOKEN]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_TOKEN]")
    .replace(/(https?|socks5h?):\/\/[^\s/@]+:[^\s/@]+@/g, "$1://[REDACTED]@");
}

export function canonicalMediaUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (/(^|\.)tiktok\.com$/i.test(url.hostname) && /\/(video|photo)\/\d+/.test(url.pathname)) {
      url.search = "";
      url.hash = "";
    }
    return url.toString();
  } catch { return raw; }
}

export function shouldFallbackToDocument(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /IMAGE_PROCESS_FAILED|PHOTO_INVALID_DIMENSIONS/i.test(message);
}

export function failureDecision(error: Error, attemptsMade: number, attempts: number) {
  const restricted = /private video|video has been removed/i.test(error.message) ||
    (!error.message.includes(" | fallback:") && /log in for access|login required|video unavailable/i.test(error.message));
  const terminal = restricted || error.name === "NonRetryableDownloadError" || attemptsMade >= attempts;
  return {
    terminal,
    message: !terminal
      ? `⏳ Временная ошибка. Повторяю обработку (${attemptsMade + 1}/${attempts})…`
      : restricted
        ? "❌ Публикация недоступна без авторизации или удалена. Попробуйте другую ссылку."
        : "❌ Не удалось обработать ссылку после повторных попыток. Попробуйте позже или другую публикацию.",
  };
}
