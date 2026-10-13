import { describe, expect, it } from "vitest";
import { galleryDlPlatform, galleryDlArgs, parseGalleryDlImageUrls } from "../galleryDownload";

describe("gallery-dl allowlist and image-only extraction", () => {
  it.each([
    ["https://bsky.app/profile/user.example/post/abc123", "bluesky"],
    ["https://www.reddit.com/r/pics/comments/abc123/photo/", "reddit"],
    ["https://redd.it/abc123", "reddit"],
    ["https://www.pinterest.com/pin/123456789/", "pinterest"],
    ["https://pin.it/AbC123", "pinterest"],
    ["https://www.flickr.com/photos/user/123456789/", "flickr"],
    ["https://www.tumblr.com/user/123456789", "tumblr"],
    ["https://user.tumblr.com/post/123456789", "tumblr"],
    ["https://www.facebook.com/user/posts/123456789", "facebook"],
    ["https://vk.com/wall-123456_789012", "vk"],
    ["https://www.instagram.com/p/AbCdEf123/", "instagram"],
  ])("allows supported public-post URL %s", (url, platform) => {
    expect(galleryDlPlatform(url)).toBe(platform);
  });

  it.each([
    "https://example.com/bsky.app/profile/user/post/id",
    "https://notreddit.com/r/pics/comments/id",
    "https://facebook.com.evil.example/user/posts/123",
    "https://bsky.app.evil.example/profile/user/post/id",
    "http://bsky.app/profile/user/post/id",
    "https://user:pass@bsky.app/profile/user/post/id",
    "https://127.0.0.1/user/posts/123",
    "http://[::ffff:7f00:1]/image.jpg",
    "http://router.local/image.jpg",
      "https://192.0.2.1/photo.jpg",
      "https://224.0.0.1/photo.jpg",
    "https://vk.com/clip-123456_789012",
    "https://www.instagram.com/accounts/login/",
    "https://www.reddit.com/r/pics/",
  ])("rejects non-post, private-host or unsupported URL %s", url => {
    expect(galleryDlPlatform(url)).toBeNull();
  });

  it("passes fixed safe flags, asks for at most ten images, and never passes cookies", () => {
    const args = galleryDlArgs("https://bsky.app/profile/user.example/post/abc123");
    expect(args).toContain("--config-ignore");
    expect(args).toContain("--no-input");
    expect(args).toContain("--resolve-urls");
    expect(args).not.toContain("--get-urls");
    expect(args).toContain("--range");
    expect(args).toContain("1-10");
    expect(args).toContain("--filter");
    expect(args.some(x => /cookie|password|\$HOME/i.test(x))).toBe(false);
  });

  it("parses only public HTTP image URLs, deduplicates, and caps results", () => {
    const lines = [
      "https://cdn.example/photo.jpg?size=large",
      "https://cdn.example/photo.jpg?size=large",
      "https://cdn.example/xrpc/getBlob?cid=abc",
      "file:///etc/passwd",
      "http://127.0.0.1/private.jpg",
      "https://cdn.example/clip.mp4",
      ...Array.from({length: 12}, (_, i) => `https://cdn.example/${i}.webp`),
    ].join("\n");
    const result = parseGalleryDlImageUrls(lines);
    expect(result).toHaveLength(10);
    expect(result[0]).toBe("https://cdn.example/photo.jpg?size=large");
    expect(result).toContain("https://cdn.example/xrpc/getBlob?cid=abc");
    expect(result.some(url => url.endsWith("clip.mp4"))).toBe(false);
    expect(result.some(url => url.includes("127.0.0.1"))).toBe(false);
  });

  it("does not mistake Pinterest short-link redirects for images", () => {
    const image = "https://i.pinimg.com/originals/ab/cd/ef/image.jpg";
    const result = parseGalleryDlImageUrls([
      "https://pin.it/AbC123",
      "https://www.pinterest.com/pin/123456789/",
      "https://www.pinterest.com/pin/123456789/sent/?invite_code=example",
      image,
    ].join("\n"));
    expect(result).toEqual([image]);
  });
});
