import type { Job } from "bullmq";
import type { JobData } from "./types";

export function buildStatPayload(
  job: Pick<Job<JobData>, "data">,
  started: number,
  status: string,
  bytes: number,
  errorMessage?: string,
) {
  const data = job.data;
  return {
    ts: started,
    url: data.url,
    status,
    bytes,
    duration_ms: Date.now() - started,
    chat_id: data.chatId,
    source_message_id: data.messageId,
    source_thread_id: data.messageThreadId ?? null,
    user_id: data.userId ?? null,
    username: data.username ?? null,
    first_name: data.firstName ?? null,
    platform: data.platform ?? null,
    error_message: errorMessage ?? null,
  };
}
