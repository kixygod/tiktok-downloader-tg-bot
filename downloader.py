import requests
import re
import logging
from yt_dlp import YoutubeDL

log = logging.getLogger(__name__)
UA = {"User-Agent": "Mozilla/5.0"}


def _expand(url: str) -> str:
    """Разворачивает vm.tiktok.com и tiktok.com/t/... в полный линк."""
    if re.match(r"https?://(?:vm\.)?tiktok\.com/(?:t|[A-Za-z0-9]+)", url):
        try:
            return requests.head(
                url, allow_redirects=True, headers=UA, timeout=10
            ).url
        except Exception as e:
            log.warning("_expand failed: %s", e)
    return url


def _snap(url: str):
    r = requests.post(
        "https://snaptik.app/abc.php", data={"url": url}, headers=UA, timeout=12
    )
    if r.status_code != 200:
        raise RuntimeError(f"SnapTik HTTP {r.status_code}")
    m = re.search(r'(https://[^"]+snaptik[^"]+download[^"]+\.mp4)', r.text)
    if not m:
        raise RuntimeError("SnapTik: link not found")
    return "video", requests.get(m.group(1), headers=UA, timeout=20).content


def _tikwm(url: str):
    r = requests.get(
        "https://tikwm.com/api/",
        params={"url": url},
        headers=UA,
        timeout=12,
    )
    js = r.json()
    if js.get("code") != 0:
        raise RuntimeError(f"tikwm: {js.get('msg')}")
    d = js["data"]

    t = d.get("type")
    if t == "video":
        src = d["hdplay"] or d["play"]
        return "video", requests.get(src, headers=UA, timeout=20).content

    # Tikwm иногда отдаёт photo-посты так:
    #   {"type":"photo", "images":[...]}  или вообще без type
    if t in ("image", "photo") or d.get("images"):
        imgs = [
            requests.get(i, headers=UA, timeout=15).content for i in d["images"]
        ]
        return "images", imgs

    raise RuntimeError("tikwm: unknown type")


def _vxtt(url: str):
    r = requests.get(
        f"https://ripple-vx-tiktok.vercel.app/api?url={url}",
        headers=UA,
        timeout=12,
    )
    js = r.json()
    if js.get("status") != "success":
        raise RuntimeError("vxtiktok: fail")
    if js["data"]["type"] == "video":
        src = js["data"]["video"]
        return "video", requests.get(src, headers=UA, timeout=20).content
    raise RuntimeError("vxtiktok: only video supported")


def _tikmate(url: str):
    i = url.rstrip("/").split("/")[-1].split("?")[0]
    token = requests.get(
        f"https://api.tikmate.app/api/lookup?id={i}", headers=UA, timeout=12
    ).json()["token"]
    dl = f"https://tikmate.app/download/{token}/{i}.mp4"
    return "video", requests.get(dl, headers=UA, timeout=20).content


def _ssstik(url: str):
    r = requests.post(
        "https://ssstik.io/abc?url=dl",
        data={"id": url, "locale": "en"},
        headers=UA,
        timeout=12,
    )
    m = re.search(r'href=\"(https://[^"]+\.mp4)\"', r.text)
    if not m:
        raise RuntimeError("ssstik: link not found")
    return "video", requests.get(m.group(1), headers=UA, timeout=20).content


def _douyin(url: str):
    r = requests.get(
        "https://api.douyin.wtf/api",
        params={"url": url, "minimal": "false"},
        headers={**UA, "Accept": "application/json"},
        timeout=12,
    )
    try:
        js = r.json()
    except ValueError:
        raise RuntimeError("douyin: non-JSON response")

    if js.get("status_code") != 0:
        raise RuntimeError(f"douyin: {js.get('status_msg')}")
    d = js["data"]

    if d.get("images"):
        imgs = [
            requests.get(i, headers=UA, timeout=15).content for i in d["images"]
        ]
        return "images", imgs

    src = (
        d.get("nwm_video_url_HQ")
        or d.get("nwm_video_url")
        or d.get("wm_video_url")
    )
    if not src:
        raise RuntimeError("douyin: no media url")
    return "video", requests.get(src, headers=UA, timeout=20).content


def _ytdlp(url: str):
    with YoutubeDL({"quiet": True, "skip_download": True}) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("ext") == "mp4":
        src = info["url"]
        return "video", requests.get(src, headers=UA, timeout=25).content
    if info.get("_type") == "playlist":
        imgs = [
            requests.get(e["url"], headers=UA, timeout=15).content
            for e in info["entries"]
        ]
        return "images", imgs
    raise RuntimeError("yt-dlp: unsupported")


DOWNLOADERS = (
    _snap,
    _tikwm,
    _vxtt,
    _tikmate,
    _ssstik,
    _douyin,   # ← фото/видео без ватермарки
    _ytdlp,
)


def fetch(url: str):
    url = _expand(url)
    last = None
    for fn in DOWNLOADERS:
        try:
            return fn(url)
        except Exception as e:
            last = e
            log.warning("%s failed: %s", fn.__name__, e)
    raise last or RuntimeError("all downloaders failed")
