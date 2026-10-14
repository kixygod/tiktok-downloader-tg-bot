/** Платформа источника контента */
export type Platform = "tiktok" | "youtube" | "vk" | "instagram" | "twitter";

/** Извлечённая ссылка с платформой */
export interface ExtractedUrl {
  url: string;
  platform: string;
}

/** Данные задачи в очереди BullMQ */
export interface JobData {
  chatId: number;
  messageId: number;
  messageThreadId?: number;
  ackMessageId: number;
  url: string;
  platform: string;
  userId: number | null;
  username: string | null;
  firstName: string | null;
  sizeLimitMB: number;
}

/** Тело POST /stats */
export interface StatsBody {
  event_id?: string;
  ts: number;
  url: string;
  status: "success" | "failed" | "cached" | "compressed" | "too_large";
  bytes: number;
  duration_ms: number;
  chat_id: number;
  source_message_id?: number | null;
  source_thread_id?: number | null;
  user_id?: number | null;
  username?: string | null;
  first_name?: string | null;
  platform?: string | null;
  error_message?: string | null;
}

/** Кэш чата Telegram */
export interface ChatCache {
  title?: string;
  type?: string;
  username?: string;
}
