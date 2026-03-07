import { describe, it, expect } from "vitest";
import { fmtBytes, fmtDuration, escapeHtml } from "../utils";

describe("fmtBytes", () => {
  it("форматирует байты", () => {
    expect(fmtBytes(500)).toBe("500 B");
  });

  it("форматирует килобайты", () => {
    expect(fmtBytes(1536)).toBe("1.5 KB");
  });

  it("форматирует мегабайты", () => {
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("форматирует гигабайты", () => {
    expect(fmtBytes(2 * 1024 * 1024 * 1024)).toBe("2.00 GB");
  });
});

describe("fmtDuration", () => {
  it("форматирует миллисекунды", () => {
    expect(fmtDuration(500)).toBe("500ms");
  });

  it("форматирует секунды", () => {
    expect(fmtDuration(5500)).toBe("5.5s");
  });

  it("форматирует минуты", () => {
    expect(fmtDuration(125000)).toBe("2m 5s");
  });
});

describe("escapeHtml", () => {
  it("экранирует < и >", () => {
    expect(escapeHtml("<script>")).toBe("&lt;script&gt;");
  });

  it("экранирует &", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("не меняет безопасный текст", () => {
    expect(escapeHtml("hello")).toBe("hello");
  });
});
