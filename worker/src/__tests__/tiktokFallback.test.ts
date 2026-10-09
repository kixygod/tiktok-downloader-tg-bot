import { describe, expect, it } from "vitest";
import { tikTokFallbackRequests, parseTikTokFallbackMedia, fetchSssTikMedia, parseSssTikMedia } from "../tiktokFallback";

const url = "https://www.tiktok.com/@example/video/7690275353465507094";

describe("cookie-free TikTok fallback contracts", () => {
  it("sends the complete URL as a POST form to Tikmate", () => {
    const request = tikTokFallbackRequests(url).find(r => r.service === "tikmate")!;
    expect(request.url).toBe("https://api.tikmate.app/api/lookup");
    expect(request.method).toBe("POST");
    expect(new URLSearchParams(request.body).get("url")).toBe(url);
    expect(request.headers.Cookie).toBeUndefined();
  });

  it("builds the download link from a successful Tikmate response without rounding the id", () => {
    expect(parseTikTokFallbackMedia("tikmate", { success: true, id: "7690275353465507094", token: "guest/token+value" }, url)).toEqual({
      type: "video", data: "https://tikmate.app/download/guest%2Ftoken%2Bvalue/7690275353465507094.mp4",
    });
  });

  it.each([
    { success: false, id: "7690275353465507094", token: "guest" },
    { success: true, id: "7694527663163100449", token: "guest" },
    { success: true, id: 7690275353465507094, token: "guest" },
    { success: true, id: "7690275353465507094", token: "" },
  ])("rejects unavailable, mismatched or incomplete media: %j", payload => {
    expect(() => parseTikTokFallbackMedia("tikmate", payload, url)).toThrow();
  });

  it("supports short links when Tikmate resolves their id", () => {
    expect(parseTikTokFallbackMedia("tikmate", { success: true, id: "7690275353465507094", token: "guest" }, "https://vt.tiktok.com/ZSbttwjP7/").type).toBe("video");
  });

  it("keeps photo albums and their order from Tikwm", () => {
    const images = ["https://cdn.example/one.jpg", "https://cdn.example/two.jpg"];
    expect(parseTikTokFallbackMedia("tikwm", { code: 0, data: { images, play: "https://cdn.example/preview.mp4" } }, url)).toEqual({ type: "images", data: images });
  });

  it("rejects a Tikwm error or incomplete album", () => {
    expect(() => parseTikTokFallbackMedia("tikwm", { code: -1, msg: "not found" }, url)).toThrow();
    expect(() => parseTikTokFallbackMedia("tikwm", { code: 0, data: { images: ["https://cdn.example/one.jpg", null] } }, url)).toThrow();
  });

  it("selects ordered slides, excluding avatar, music and video previews", () => {
    const html = '<img src="https://tikcdn.io/avatar"><a class="download_link music" href="https://tikcdn.io/audio">Music</a>' +
      '<a href="https://tikcdn.io/one?x=1&amp;y=2" class="download_link slide">1</a>' +
      '<a class="download_link slide" href="https://tikcdn.io/two">2</a>';
    expect(parseSssTikMedia(html)).toEqual({ type: "images", data: ["https://tikcdn.io/one?x=1&y=2", "https://tikcdn.io/two"] });
  });

  it("selects video and rejects unexpected hosts or incomplete albums", () => {
    expect(parseSssTikMedia('<a href="https://tikcdn.io/video" class="download_link without_watermark">MP4</a>')).toEqual({ type: "video", data: "https://tikcdn.io/video" });
    expect(() => parseSssTikMedia('<a href="http://127.0.0.1/video" class="download_link without_watermark">MP4</a>')).toThrow();
    expect(() => parseSssTikMedia('<a class="download_link slide" href="https://tikcdn.io/one">1</a><a class="download_link slide">2</a>')).toThrow();
  });

  it("uses a fresh guest form token without cookies or executing page JavaScript", async () => {
    const requests: Array<{url: string; options: RequestInit}> = [];
    const fetcher = async (address: string, options: RequestInit) => {
      requests.push({url: address, options});
      return new Response(requests.length === 1 ? "window.s_tt = 'guest-token';" : '<a class="download_link without_watermark" href="https://tikcdn.io/video">MP4</a>');
    };
    expect((await fetchSssTikMedia(url, fetcher)).type).toBe("video");
    expect(requests[1].options.method).toBe("POST");
    const form = new URLSearchParams(String(requests[1].options.body));
    expect(form.get("id")).toBe(url);
    expect(form.get("tt")).toBe("guest-token");
    expect(requests.every(r => r.options.credentials === "omit")).toBe(true);
  });

  it("reports an HTTP failure instead of parsing its challenge page as media", async () => {
    await expect(fetchSssTikMedia(url, async () => new Response("challenge", {status: 403}))).rejects.toThrow("HTTP 403");
  });
});
