import { describe, it, expect } from "vitest";
import {
  extractTikTokItemId,
  isTikTokPhotoUrl,
  parseTikTokImageUrlsFromHtml,
  tiktokPhotoCandidatePages,
} from "../tiktokPhotos";

describe("extractTikTokItemId", () => {
  it("достаёт id из /photo/", () => {
    expect(
      extractTikTokItemId(
        "https://www.tiktok.com/@brus15616/photo/7662829044961938710?_r=1",
      ),
    ).toBe("7662829044961938710");
  });

  it("достаёт id из /video/", () => {
    expect(
      extractTikTokItemId(
        "https://www.tiktok.com/@u/video/1234567890123456789",
      ),
    ).toBe("1234567890123456789");
  });
});

describe("isTikTokPhotoUrl", () => {
  it("распознаёт карусель", () => {
    expect(
      isTikTokPhotoUrl("https://www.tiktok.com/@u/photo/7662829044961938710"),
    ).toBe(true);
  });

  it("не считает видео фото", () => {
    expect(
      isTikTokPhotoUrl("https://www.tiktok.com/@u/video/7662829044961938710"),
    ).toBe(false);
  });
});

describe("tiktokPhotoCandidatePages", () => {
  it("ставит embed выше исходной страницы", () => {
    const pages = tiktokPhotoCandidatePages(
      "https://www.tiktok.com/@u/photo/7662829044961938710",
    );
    expect(pages[0]).toBe("https://www.tiktok.com/embed/v2/7662829044961938710");
    expect(pages).toContain("https://www.tiktok.com/embed/7662829044961938710");
  });
});

describe("parseTikTokImageUrlsFromHtml", () => {
  it("читает displayImages.urlList из embed-разметки", () => {
    const html = `
      <script>window.__frontity={"imagePostInfo":{"displayImages":[
        {"height":640,"width":1080,"urlList":[
          "https://p16-sign.tiktokcdn-eu.com/tos-no1a-i-photomode-no/aaa111aaa111aaa111aaa111aaa111aa~tplv-photomode-image.jpeg?x=1",
          "https://p19-sign.tiktokcdn-eu.com/tos-no1a-i-photomode-no/aaa111aaa111aaa111aaa111aaa111aa~tplv-photomode-image.jpeg?x=2"
        ]},
        {"height":800,"width":600,"urlList":[
          "https://p16-sign.tiktokcdn-eu.com/tos-no1a-i-photomode-no/bbb222bbb222bbb222bbb222bbb222bb~tplv-photomode-image.jpeg?x=1"
        ]}
      ]}}</script>`;
    const urls = parseTikTokImageUrlsFromHtml(html);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("aaa111aaa111aaa111aaa111aaa111aa");
    expect(urls[1]).toContain("bbb222bbb222bbb222bbb222bbb222bb");
  });

  it("читает классический imagePost.images", () => {
    const html = `{"imagePost":{"images":[{"imageURL":{"urlList":[
      "https://cdn.example/tos-useast5-i-photomode-tx/cccccccccccccccccccccccccccccccc~tplv-photomode-image.jpeg"
    ]}}]}}`;
    expect(parseTikTokImageUrlsFromHtml(html)).toEqual([
      "https://cdn.example/tos-useast5-i-photomode-tx/cccccccccccccccccccccccccccccccc~tplv-photomode-image.jpeg",
    ]);
  });

  it("игнорирует чужие urlList (аватар и т.п.)", () => {
    const html = `{"avatar":{"urlList":["https://p16-sign.tiktokcdn.com/avatar.jpeg"]}}`;
    expect(parseTikTokImageUrlsFromHtml(html)).toEqual([]);
  });

  it("достаёт UNIVERSAL_DATA_FOR_REHYDRATION", () => {
    const payload = {
      __DEFAULT_SCOPE__: {
        "webapp.video-detail": {
          itemInfo: {
            itemStruct: {
              imagePost: {
                images: [
                  {
                    imageURL: {
                      urlList: [
                        "https://p16.tiktokcdn.com/tos-x-i-photomode-x/dddddddddddddddddddddddddddddddd~tplv-photomode-image.jpeg",
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    };
    const html = `<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify(
      payload,
    )}</script>`;
    expect(parseTikTokImageUrlsFromHtml(html)).toHaveLength(1);
  });
});
