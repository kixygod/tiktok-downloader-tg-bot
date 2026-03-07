/** Данные задачи в очереди BullMQ */
export interface JobData {
  chatId: number;
  messageId: number;
  ackMessageId: number;
  url: string;
  platform: string;
  userId: number | null;
  username: string | null;
  firstName: string | null;
  sizeLimitMB: number;
}
