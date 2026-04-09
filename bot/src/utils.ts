import { createHmac, timingSafeEqual } from "node:crypto";

/** Общий секрет для POST /stats без отдельной переменной окружения (тот же BOT_TOKEN у bot и worker). */
export function deriveStatsIngestSecret(botToken: string): string {
  return createHmac("sha256", botToken)
    .update("tiktok-bot:stats-ingest:v1")
    .digest("hex");
}

export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024)
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function parseDashboardBasicAuth(raw: string): {
  username: string;
  password: string;
} {
  const idx = raw.indexOf(":");
  if (idx === -1) return { username: raw, password: "" };
  return { username: raw.slice(0, idx), password: raw.slice(idx + 1) };
}

export function timingSafeEqualUtf8(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, "utf8");
    const bb = Buffer.from(b, "utf8");
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}
