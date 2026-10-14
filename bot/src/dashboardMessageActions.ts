import type { FastifyInstance } from "fastify";
import type { Bot } from "grammy";

export interface MessageActionTarget {
  chat_id: string | number;
  source_message_id: string | number | null;
  source_thread_id: string | number | null;
}

export function registerDashboardMessageActions(
  secured: FastifyInstance,
  bot: Bot,
  messageActionTarget: (jobId: number) => Promise<MessageActionTarget | null>,
): void {
  const requireDashboardOrigin = (request: any, reply: any): boolean => {
    const origin = request.headers.origin;
    const forwardedProto = String(request.headers["x-forwarded-proto"] ?? "")
      .split(",")[0]
      .trim();
    const protocol = forwardedProto || request.protocol;
    let sameOrigin = false;
    try {
      sameOrigin = Boolean(origin) && new URL(origin).origin === new URL(`${protocol}://${request.headers.host}`).origin;
    } catch {}
    if (!sameOrigin) {
      reply.status(403).send({ error: "Запрос должен прийти из админки." });
      return false;
    }
    return true;
  };

  secured.post(
    "/api/admin/jobs/:jobId/reaction",
    {
      schema: {
        body: {
          type: "object",
          required: ["emoji"],
          properties: { emoji: { type: "string", minLength: 1, maxLength: 32 } },
          additionalProperties: false,
        },
      },
    },
    async (request: any, reply: any) => {
      if (!requireDashboardOrigin(request, reply)) return;
      const jobId = Number(request.params.jobId);
      const target = await messageActionTarget(jobId);
      if (!target) return reply.status(404).send({ error: "У заявки нет сохранённого исходного сообщения." });
      const emoji = String(request.body.emoji);
      const remove = emoji === "remove";
      const isEmoji = /^[\p{Extended_Pictographic}\p{Regional_Indicator}\uFE0F\u200D\u{1F3FB}-\u{1F3FF}]+$/u.test(emoji);
      if (!remove && (!isEmoji || Array.from(emoji).length > 12)) {
        return reply.status(400).send({ error: "Выбери один эмодзи реакции." });
      }
      try {
        const reaction: Parameters<typeof bot.api.setMessageReaction>[2] = remove
          ? []
          : [{ type: "emoji", emoji: emoji.replace(/\uFE0F/g, "") as any }];
        await bot.api.setMessageReaction(
          Number(target.chat_id),
          Number(target.source_message_id),
          reaction,
        );
        request.log.info({ jobId, emoji: remove ? null : emoji }, "Dashboard reaction updated");
        return reply.send({ ok: true, message: remove ? "Реакция снята." : `Реакция ${emoji} поставлена.` });
      } catch (error) {
        request.log.warn({ error, jobId }, "Telegram rejected dashboard reaction");
        return reply.status(502).send({ error: "Telegram не принял реакцию. Возможно, она запрещена в этом чате." });
      }
    },
  );

  secured.post(
    "/api/admin/jobs/:jobId/reply",
    {
      schema: {
        body: {
          type: "object",
          required: ["text"],
          properties: { text: { type: "string", minLength: 1, maxLength: 4096 } },
          additionalProperties: false,
        },
      },
    },
    async (request: any, reply: any) => {
      if (!requireDashboardOrigin(request, reply)) return;
      const jobId = Number(request.params.jobId);
      const target = await messageActionTarget(jobId);
      if (!target) return reply.status(404).send({ error: "У заявки нет сохранённого исходного сообщения." });
      const messageText = String(request.body.text).trim();
      if (!messageText || messageText.length > 4096) {
        return reply.status(400).send({ error: "Текст должен содержать от 1 до 4096 символов." });
      }
      try {
        await bot.api.sendMessage(Number(target.chat_id), messageText, {
          ...(target.source_thread_id == null
            ? {}
            : { message_thread_id: Number(target.source_thread_id) }),
          reply_parameters: {
            message_id: Number(target.source_message_id),
          },
        });
        request.log.info({ jobId }, "Dashboard reply sent");
        return reply.send({ ok: true, message: "Ответ отправлен от имени бота." });
      } catch (error) {
        request.log.warn({ error, jobId }, "Telegram rejected dashboard reply");
        return reply.status(502).send({ error: "Telegram не смог отправить сообщение. Проверь, доступен ли боту этот чат." });
      }
    },
  );
}
