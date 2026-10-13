import { describe, expect, it, vi } from "vitest";
import { sendWithDocumentFallback } from "../imageDelivery";

describe("image delivery", () => {
  it("sends a rejected photo as a document", async () => {
    const sendPhoto = vi.fn().mockRejectedValue(
      new Error("Bad Request: IMAGE_PROCESS_FAILED"),
    );
    const sendDocument = vi.fn().mockResolvedValue({ message_id: 42 });

    await expect(sendWithDocumentFallback(sendPhoto, sendDocument)).resolves.toBe(
      "document",
    );
    expect(sendPhoto).toHaveBeenCalledOnce();
    expect(sendDocument).toHaveBeenCalledOnce();
  });

  it("does not retry unrelated failures as documents", async () => {
    const sendPhoto = vi.fn().mockRejectedValue(new Error("Too Many Requests"));
    const sendDocument = vi.fn();

    await expect(sendWithDocumentFallback(sendPhoto, sendDocument)).rejects.toThrow(
      "Too Many Requests",
    );
    expect(sendDocument).not.toHaveBeenCalled();
  });

  it("propagates a failed document fallback", async () => {
    const sendPhoto = vi.fn().mockRejectedValue(
      new Error("Bad Request: PHOTO_INVALID_DIMENSIONS"),
    );
    const sendDocument = vi.fn().mockRejectedValue(new Error("Bad Request: CHAT_NOT_FOUND"));

    await expect(sendWithDocumentFallback(sendPhoto, sendDocument)).rejects.toThrow(
      "CHAT_NOT_FOUND",
    );
  });
});
