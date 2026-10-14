import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { Bot } from "grammy";
import { registerDashboardAuth } from "../dashboardAuth";
import { registerDashboardMessageActions, type MessageActionTarget } from "../dashboardMessageActions";

describe("dashboard replies and reactions", () => {
  let app: FastifyInstance;
  let bot: Bot;
  let target: MessageActionTarget | null;
  const resolveTarget = vi.fn(async (_jobId: number) => target);
  const headers = {
    authorization: `Basic ${Buffer.from("admin:test-password").toString("base64")}`,
    origin: "http://localhost",
  };

  beforeEach(async () => {
    app = Fastify();
    bot = new Bot("123:test-token");
    target = { chat_id: "-1001234567890", source_message_id: "123", source_thread_id: "42" };
    resolveTarget.mockClear();
    vi.spyOn(bot.api, "setMessageReaction").mockResolvedValue(true);
    vi.spyOn(bot.api, "sendMessage").mockResolvedValue({
      message_id: 124, date: 0, chat: { id: -1001234567890, type: "supergroup", title: "Test" }, text: "Reply",
    });
    await app.register(async (secured) => {
      await registerDashboardAuth(secured, "admin:test-password");
      registerDashboardMessageActions(secured, bot, resolveTarget);
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it("sends a reply to the exact source message in its forum topic", async () => {
    const response = await app.inject({ method: "POST", url: "/api/admin/jobs/2515/reply", headers, payload: { text: "  Спасибо!  " } });
    expect(response.statusCode).toBe(200);
    expect(resolveTarget).toHaveBeenCalledWith(2515);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(-1001234567890, "Спасибо!", {
      message_thread_id: 42, reply_parameters: { message_id: 123 },
    });
  });

  it("keeps a private-chat reply attached to the source message", async () => {
    target = { chat_id: "123456", source_message_id: "9", source_thread_id: null };
    const response = await app.inject({ method: "POST", url: "/api/admin/jobs/2515/reply", headers, payload: { text: "Reply" } });
    expect(response.statusCode).toBe(200);
    expect(bot.api.sendMessage).toHaveBeenCalledWith(123456, "Reply", { reply_parameters: { message_id: 9 } });
  });

  it("accepts the dashboard origin on its published port", async () => {
    const response = await app.inject({ method: "POST", url: "/api/admin/jobs/2515/reply", headers: { ...headers, host: "localhost:53500", origin: "http://localhost:53500" }, payload: { text: "Reply" } });
    expect(response.statusCode).toBe(200);
  });

  it.each(["\u{1F44D}", "\u2764\uFE0F", "\u{1F923}", "remove"])("sets or removes reaction %s on the original message", async (emoji) => {
    const response = await app.inject({ method: "POST", url: "/api/admin/jobs/2515/reaction", headers, payload: { emoji } });
    expect(response.statusCode).toBe(200);
    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(-1001234567890, 123,
      emoji === "remove" ? [] : [{ type: "emoji", emoji: emoji.replace(/\uFE0F/g, "") }]);
  });

  it.each(["reply", "reaction"])("requires authentication for %s", async (action) => {
    const response = await app.inject({ method: "POST", url: `/api/admin/jobs/2515/${action}`, headers: { origin: headers.origin }, payload: { text: "Reply", emoji: "remove" } });
    expect(response.statusCode).toBe(401);
    expect(resolveTarget).not.toHaveBeenCalled();
  });

  it.each([undefined, "https://untrusted.example", "null"])("rejects untrusted origin %s", async (origin) => {
    const response = await app.inject({ method: "POST", url: "/api/admin/jobs/2515/reply", headers: { authorization: headers.authorization, ...(origin ? { origin } : {}) }, payload: { text: "Reply" } });
    expect(response.statusCode).toBe(403);
    expect(resolveTarget).not.toHaveBeenCalled();
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["reply", "reaction"])("cannot act on an old request without its source message: %s", async (action) => {
    target = null;
    const response = await app.inject({ method: "POST", url: `/api/admin/jobs/2515/${action}`, headers, payload: action === "reply" ? { text: "Reply" } : { emoji: "remove" } });
    expect(response.statusCode).toBe(404);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
    expect(bot.api.setMessageReaction).not.toHaveBeenCalled();
  });

  it.each(["", "  ", "x".repeat(4097)])("rejects empty or overlong replies", async (text) => {
    const response = await app.inject({ method: "POST", url: "/api/admin/jobs/2515/reply", headers, payload: { text } });
    expect(response.statusCode).toBe(400);
    expect(bot.api.sendMessage).not.toHaveBeenCalled();
  });

  it("reports a Telegram error without falling back to an unrelated chat message", async () => {
    vi.mocked(bot.api.sendMessage).mockRejectedValue(new Error("message to be replied not found"));
    const response = await app.inject({ method: "POST", url: "/api/admin/jobs/2515/reply", headers, payload: { text: "Reply" } });
    expect(response.statusCode).toBe(502);
    expect(bot.api.sendMessage).toHaveBeenCalledTimes(1);
  });
});
