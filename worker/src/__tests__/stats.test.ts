import { afterEach, describe, expect, it, vi } from "vitest";
import { buildStatPayload } from "../stats";
import type { JobData } from "../types";

const data: JobData = {
  chatId: -1001234567890,
  messageId: 123,
  messageThreadId: 42,
  ackMessageId: 124,
  url: "https://example.com/video",
  platform: "tiktok",
  userId: null,
  username: null,
  firstName: null,
  sizeLimitMB: 50,
};

afterEach(() => vi.restoreAllMocks());

describe("worker message references in statistics", () => {
  it.each(["success", "cached", "compressed", "too_large", "failed"])(
    "preserves the original message and forum topic for %s results",
    (status) => {
      vi.spyOn(Date, "now").mockReturnValue(2000);
      expect(buildStatPayload({ data }, 1000, status, 4096)).toMatchObject({
        chat_id: data.chatId,
        source_message_id: 123,
        source_thread_id: 42,
        ts: 1000,
        duration_ms: 1000,
        status,
      });
    },
  );

  it("keeps replies in a regular chat when there is no forum topic", () => {
    const payload = buildStatPayload({ data: { ...data, messageThreadId: undefined } }, 1000, "success", 10);
    expect(payload.source_message_id).toBe(123);
    expect(payload.source_thread_id).toBeNull();
  });
});
