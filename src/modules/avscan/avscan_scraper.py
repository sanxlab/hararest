#!/usr/bin/env python3
from __future__ import annotations

import argparse
import io
import json
import os
import re
import sys
import urllib.parse
from typing import Any

import cloudscraper

SEARCH_URL = "https://avscan.cc/search"
BASE_URL = "https://avscan.cc"
COVER_STEM_RE = re.compile(r"^(.+)_cover_(?:full|left|right)$", re.IGNORECASE)
TIMESTAMP_RE = re.compile(r"^\d{1,2}:\d{2}(?::\d{2})?$")
MAX_IMAGE_BYTES = 15 * 1024 * 1024

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/137.0.0.0 Safari/537.36"
    ),
    "Referer": "https://avscan.cc/",
    "Origin": "https://avscan.cc",
    "Accept": "application/json, text/plain, */*",
}


class AvscanError(RuntimeError):
    pass


def frame_stem(name: str) -> str:
    base = str(name).replace("\\", "/").split("/")[-1]
    return os.path.splitext(base)[0]


def parse_timestamp(name: str) -> str:
    if not name:
        return "--:--:--"
    base = frame_stem(name)
    if COVER_STEM_RE.match(base):
        return "Cover"
    idx = base.rfind("_")
    if idx == -1:
        return "--:--:--"
    raw_ts = base[idx + 1:].replace("-", ":")
    return raw_ts if TIMESTAMP_RE.match(raw_ts) else "--:--:--"


def build_thumb_url(video_code: str, image_name: str, thumb_path: str | None = None) -> str:
    if thumb_path:
        if thumb_path.startswith("http://") or thumb_path.startswith("https://"):
            return thumb_path
        prefix = "" if thumb_path.startswith("/") else "/"
        return f"{BASE_URL}{prefix}{thumb_path}"

    base = frame_stem(image_name)
    cover_match = COVER_STEM_RE.match(base)
    if cover_match:
        quoted_cover = urllib.parse.quote(cover_match.group(1))
        return f"{BASE_URL}/thumb/covers/{quoted_cover}.webp"

    quoted_code = urllib.parse.quote(video_code)
    quoted_base = urllib.parse.quote(base)
    return f"{BASE_URL}/thumb/{quoted_code}/{quoted_base}.webp"


def guess_mime_type(data: bytes) -> tuple[str, str]:
    if data.startswith(b"\xff\xd8\xff"):
        return "image.jpg", "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image.png", "image/png"
    if data.startswith(b"RIFF") and len(data) >= 12 and data[8:12] == b"WEBP":
        return "image.webp", "image/webp"
    return "image.jpg", "image/jpeg"


def read_image_bytes(input_source: str, scraper: cloudscraper.CloudScraper, timeout: float = 30.0) -> bytes:
    trimmed = input_source.strip()
    if not trimmed:
        raise AvscanError("Image input is empty.")

    if trimmed.startswith("http://") or trimmed.startswith("https://"):
        parsed = urllib.parse.urlparse(trimmed)
        if not parsed.hostname:
            raise AvscanError("Invalid image URL.")

        try:
            resp = scraper.get(trimmed, timeout=timeout, stream=True)
            resp.raise_for_status()

            chunks: list[bytes] = []
            total_size = 0
            for chunk in resp.iter_content(chunk_size=65536):
                total_size += len(chunk)
                if total_size > MAX_IMAGE_BYTES:
                    raise AvscanError(f"Image exceeds maximum size of {MAX_IMAGE_BYTES} bytes.")
                chunks.append(chunk)

            raw = b"".join(chunks)
        except Exception as exc:
            raise AvscanError(f"Failed to download image from URL: {exc}") from exc
    elif os.path.isfile(trimmed):
        if os.path.getsize(trimmed) > MAX_IMAGE_BYTES:
            raise AvscanError(f"Image file exceeds maximum size of {MAX_IMAGE_BYTES} bytes.")
        with open(trimmed, "rb") as f:
            raw = f.read()
    else:
        raise AvscanError(f"Image file not found: {trimmed}")

    if len(raw) < 50:
        raise AvscanError("Image data is too small or corrupt.")
    return raw


def search_avscan(
    input_source: str,
    scraper: cloudscraper.CloudScraper | None = None,
    timeout: float = 30.0,
) -> dict[str, Any]:
    if scraper is None:
        scraper = cloudscraper.create_scraper()

    raw_bytes = read_image_bytes(input_source, scraper, timeout=timeout)
    filename, mime_type = guess_mime_type(raw_bytes)

    files = {"file": (filename, raw_bytes, mime_type)}

    try:
        resp = scraper.post(SEARCH_URL, headers=DEFAULT_HEADERS, files=files, timeout=timeout)
    except Exception as exc:
        raise AvscanError(f"AVScan connection failed: {exc}") from exc

    if resp.status_code == 429:
        raise AvscanError("AVScan rate limit exceeded. Please try again later.")
    if resp.status_code in (403, 503):
        raise AvscanError("AVScan request was blocked by Cloudflare.")
    if resp.status_code != 200:
        raise AvscanError(f"AVScan returned HTTP status {resp.status_code}.")

    try:
        data = resp.json()
    except Exception as exc:
        raise AvscanError("AVScan response is not valid JSON.") from exc

    raw_results = data.get("results") or []
    parsed_results: list[dict[str, Any]] = []

    for item in raw_results:
        video_code = str(item.get("video_code") or "").strip()
        best_sim = float(item.get("best_similarity") or 0.0)
        raw_frames = item.get("frames") or []

        frames: list[dict[str, Any]] = []
        for f in raw_frames:
            img_name = f.get("image_name") or ""
            sim = float(f.get("similarity") or 0.0)
            thumb = f.get("thumb") or ""
            ts = parse_timestamp(img_name)
            t_url = build_thumb_url(video_code, img_name, thumb)
            frames.append({
                "image_name": img_name,
                "similarity": sim,
                "timestamp": ts,
                "thumb_url": t_url,
            })

        best_thumb = ""
        best_ts = "--:--:--"
        if frames:
            frames.sort(key=lambda x: x["similarity"], reverse=True)
            best_thumb = frames[0]["thumb_url"]
            best_ts = frames[0]["timestamp"]

        code_lower = video_code.lower()
        quoted_code = urllib.parse.quote(video_code)
        watch_urls = {
            "missav": f"https://missav.ai/en/{code_lower}",
            "javdb": f"https://javdb.com/search?q={quoted_code}&f=all",
            "javbus": f"https://www.javbus.com/{quoted_code}",
            "avscan_direct": f"{BASE_URL}/go/m/en/{code_lower}?s=r",
        }

        parsed_results.append({
            "video_code": video_code,
            "best_similarity": best_sim,
            "best_timestamp": best_ts,
            "best_thumb": best_thumb,
            "frames": frames,
            "watch_urls": watch_urls,
        })

    parsed_results.sort(key=lambda x: x["best_similarity"], reverse=True)

    return {
        "status": "ok",
        "results": parsed_results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Search AVScan by image file or URL.")
    parser.add_argument("input", help="Local image file path or image URL")
    parser.add_argument("--timeout", type=float, default=30.0, help="Request timeout in seconds")
    args = parser.parse_args()

    try:
        scraper = cloudscraper.create_scraper()
        result = search_avscan(args.input, scraper=scraper, timeout=args.timeout)
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        return 0
    except AvscanError as exc:
        sys.stderr.write(json.dumps({"status": "error", "message": str(exc)}) + "\n")
        sys.stderr.flush()
        return 1
    except Exception as exc:
        sys.stderr.write(json.dumps({"status": "error", "message": f"Unexpected error: {exc}"}) + "\n")
        sys.stderr.flush()
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
