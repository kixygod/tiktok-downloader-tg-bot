import logging, re, requests
from yt_dlp import YoutubeDL, utils as ytdlp_utils

log = logging.getLogger(__name__)
UA = {"User-Agent": "Mozilla/5.0"}

YDL_BASE = {
    "quiet": True,
    "skip_download": True,
    "socket_timeout": 10,
    "nocheckcertificate": True,
    "retries": 3,
    "windows_filenames": True,
}

MAX_MB_INLINE = 49
MAX_MB_CHAT = 49


def _expand(url: str) -> str:
    if re.match(r"https?://(?:vm\.)?tiktok\.com/(?:t|[A-Za-z0-9]+)", url):
        try:
            return requests.head(url, allow_redirects=True, headers=UA, timeout=10).url
        except Exception as e:
            log.warning("_expand failed: %s", e)
    return url


def _is_tiktok(url: str) -> bool:
    return "tiktok.com" in url


def _snap(url: str, *, inline=False):
    if not _is_tiktok(url):
        raise RuntimeError("skip")
    r = requests.post(
        "https://snaptik.app/abc.php", data={"url": url}, headers=UA, timeout=12
    )
    if r.status_code != 200:
        raise RuntimeError(f"SnapTik HTTP {r.status_code}")
    m = re.search(r'(https://[^"]+snaptik[^"]+download[^"]+\.mp4)', r.text)
    if not m:
        raise RuntimeError("SnapTik: ссылка не найдена")
    return "video", requests.get(m.group(1), headers=UA, timeout=20).content


def _tikwm(url: str, *, inline=False):
    if not _is_tiktok(url):
        raise RuntimeError("skip")
    js = requests.get(
        "https://tikwm.com/api/", params={"url": url}, headers=UA, timeout=12
    ).json()
    if js.get("code") != 0:
        raise RuntimeError(f"tikwm: {js.get('msg')}")
    d = js["data"]

    if d.get("type") == "video":
        src = d["hdplay"] or d["play"]
        return "video", requests.get(src, headers=UA, timeout=20).content

    imgs = d.get("images")
    if imgs:
        return (
            ("photo_url", imgs)
            if inline
            else (
                "photo",
                [requests.get(i, headers=UA, timeout=15).content for i in imgs],
            )
        )
    raise RuntimeError("tikwm: неизвестный формат")


def _vxtt(url: str, *, inline=False):
    if not _is_tiktok(url):
        raise RuntimeError("skip")
    js = requests.get(
        "https://ripple-vx-tiktok.vercel.app/api",
        params={"url": url},
        headers=UA,
        timeout=12,
    ).json()
    if js.get("status") != "success":
        raise RuntimeError("vxtiktok: fail")
    return ("video", requests.get(js["data"]["video"], headers=UA, timeout=20).content)


def _tikmate(url: str, *, inline=False):
    if not _is_tiktok(url):
        raise RuntimeError("skip")
    i = url.rstrip("/").split("/")[-1].split("?")[0]
    token = requests.get(
        f"https://api.tikmate.app/api/lookup?id={i}", headers=UA, timeout=12
    ).json()["token"]
    dl = f"https://tikmate.app/download/{token}/{i}.mp4"
    return "video", requests.get(dl, headers=UA, timeout=20).content


def _ssstik(url: str, *, inline=False):
    if not _is_tiktok(url):
        raise RuntimeError("skip")
    r = requests.post(
        "https://ssstik.io/abc?url=dl",
        data={"id": url, "locale": "en"},
        headers=UA,
        timeout=12,
    )
    m = re.search(r'href=\"(https://[^"]+\.mp4)\"', r.text)
    if not m:
        raise RuntimeError("ssstik: ссылка не найдена")
    return "video", requests.get(m.group(1), headers=UA, timeout=20).content


def _douyin(url: str, *, inline=False):
    if "douyin." not in url:
        raise RuntimeError("skip")
    r = requests.get(
        "https://api.douyin.wtf/api",
        params={"url": url, "minimal": "false"},
        headers={**UA, "Accept": "application/json"},
        timeout=12,
    )
    try:
        js = r.json()
    except ValueError:
        raise RuntimeError("douyin: non‑JSON ответ")
    if js.get("status_code") != 0:
        raise RuntimeError(f"douyin: {js.get('status_msg')}")

    d = js["data"]
    if d.get("images"):
        return (
            ("photo_url", d["images"])
            if inline
            else (
                "photo",
                [requests.get(i, headers=UA, timeout=15).content for i in d["images"]],
            )
        )

    src = d.get("nwm_video_url_HQ") or d.get("nwm_video_url") or d.get("wm_video_url")
    if not src:
        raise RuntimeError("douyin: нет ссылки на медиа")
    return "video", requests.get(src, headers=UA, timeout=20).content


def _insta(url: str, *, inline=False):
    if "instagram.com" not in url:
        raise RuntimeError("skip")
    api = "https://ripple-instagram.vercel.app/api"
    try:
        js = requests.get(api, params={"url": url}, headers=UA, timeout=12).json()
    except Exception:
        raise RuntimeError("skip")

    if js.get("status") != "success":
        raise RuntimeError("skip")

    d = js["data"]
    if d["type"] == "video":
        return "video", requests.get(d["video"], headers=UA, timeout=25).content

    if d.get("images"):
        return (
            ("photo_url", d["images"])
            if inline
            else (
                "photo",
                [requests.get(i, headers=UA, timeout=15).content for i in d["images"]],
            )
        )

    raise RuntimeError("insta: unsupported")


def _ytdlp(url: str, *, inline=False):
    if not any(
        x in url for x in ("youtube.com", "youtu.be", "tiktok.com", "instagram.com")
    ):
        raise RuntimeError("skip")

    limit = (MAX_MB_INLINE if inline else MAX_MB_CHAT) * 1024 * 1024
    ydl_opts = {
        **YDL_BASE,
        "format": (
            f"(bestvideo[ext=mp4][filesize<{limit}]+bestaudio[ext=m4a]/"
            f"best[ext=mp4][filesize<{limit}]/best[filesize<{limit}])"
        ),
    }

    try:
        with YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except (ytdlp_utils.DownloadError, ytdlp_utils.ExtractorError) as e:
        raise RuntimeError(str(e).split("\n")[0]) from None
    except Exception as e:
        raise RuntimeError(f"yt‑dlp: {e}") from None

    if not info.get("url"):
        raise RuntimeError("ролик > 50 МБ — Bot API не примет")

    data = requests.get(info["url"], headers=UA, timeout=25).content
    if not data:
        raise RuntimeError("не смог скачать (пустой ответ)")
    return "video", data


DOWNLOADERS = (
    _insta,
    _ytdlp,
    _snap,
    _tikwm,
    _vxtt,
    _tikmate,
    _ssstik,
    _douyin,
)


def fetch(url: str, *, inline: bool = False):
    url = _expand(url)
    first_err = None
    for fn in DOWNLOADERS:
        try:
            return fn(url, inline=inline)
        except RuntimeError as e:

            if str(e) != "skip" and first_err is None:
                first_err = e
        except Exception as e:
            log.warning("%s failed: %s", fn.__name__, e)
            if first_err is None:
                first_err = e
    raise first_err or RuntimeError("all downloaders failed")
