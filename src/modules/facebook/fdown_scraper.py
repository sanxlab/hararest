#!/usr/bin/env python3
"""Scrape downloadable video links from fdown.net for a Facebook URL."""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from html.parser import HTMLParser
from typing import Any
from urllib.parse import urlparse

import cloudscraper


BASE_PAGE_URL = "https://fdown.net/"
DOWNLOAD_URL = "https://fdown.net/download.php"

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/137.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Origin": "https://fdown.net",
    "Referer": BASE_PAGE_URL,
}


class FDownError(RuntimeError):
    """Raised when fdown.net returns an error or unsupported response format."""


class AnchorParser(HTMLParser):
    """Collect links from HTML anchor tags."""

    def __init__(self) -> None:
        super().__init__()
        self.links: list[dict[str, str]] = []
        self._current: dict[str, str] | None = None
        self._text_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag.lower() != "a":
            return

        attr_map = {k.lower(): (v or "") for k, v in attrs}
        href = attr_map.get("href", "").strip()
        if not href:
            return

        self._current = {
            "id": attr_map.get("id", "").strip(),
            "class": attr_map.get("class", "").strip(),
            "download": attr_map.get("download", "").strip(),
            "url": href,
        }
        self._text_parts = []

    def handle_data(self, data: str) -> None:
        if self._current is not None:
            self._text_parts.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() != "a" or self._current is None:
            return

        text = " ".join("".join(self._text_parts).split())
        item = self._current
        item["text"] = text
        self.links.append(item)
        self._current = None
        self._text_parts = []


def normalize_facebook_url(raw_url: str) -> str:
    value = (raw_url or "").strip()
    if not value:
        return ""

    try:
        parsed = urlparse(value)
    except ValueError:
        return ""

    if parsed.scheme not in {"http", "https"}:
        return ""
    if not parsed.netloc:
        return ""
    return value


def clean_text(text: str) -> str:
    no_tags = re.sub(r"<[^>]+>", " ", text)
    return " ".join(html.unescape(no_tags).split())


def extract_error_messages(result_html: str) -> list[str]:
    messages: list[str] = []

    alert_patterns = [
        r'<div[^>]*role="alert"[^>]*>(.*?)</div>',
        r'<div[^>]*class="[^"]*alert[^"]*"[^>]*>(.*?)</div>',
    ]
    for pattern in alert_patterns:
        for match in re.finditer(pattern, result_html, re.IGNORECASE | re.DOTALL):
            text = clean_text(match.group(1))
            lowered = text.lower()
            looks_like_error = any(
                needle in lowered
                for needle in (
                    "not supported",
                    "private",
                    "please make sure",
                    "uh-oh",
                    "invalid",
                    "unable",
                    "error",
                )
            )
            if text and looks_like_error and "update (" not in lowered:
                messages.append(text)

    fallback_phrases = [
        r"This website is not supported[^<]*",
        r"Uh-Oh![^<]*",
        r"This video might be private[^<]*",
        r"Please make sure the website is Facebook[^<]*",
    ]
    for pattern in fallback_phrases:
        for match in re.finditer(pattern, result_html, re.IGNORECASE):
            text = clean_text(match.group(0))
            if text:
                messages.append(text)

    deduped: list[str] = []
    deduped_norms: list[str] = []
    for message in messages:
        cleaned_message = re.sub(r"^[xX]\s*", "", message).strip()
        normalized = re.sub(r"\s+", " ", cleaned_message).strip(" .").lower()
        if not normalized or len(cleaned_message) > 400:
            continue

        is_duplicate = any(
            normalized == existing
            or normalized in existing
            or existing in normalized
            for existing in deduped_norms
        )
        if is_duplicate:
            continue

        deduped.append(cleaned_message)
        deduped_norms.append(normalized)
    return deduped


def extract_media_links(result_html: str) -> list[dict[str, str]]:
    parser = AnchorParser()
    parser.feed(result_html)

    media_links: list[dict[str, str]] = []
    seen_urls: set[str] = set()

    for link in parser.links:
        href = html.unescape(link.get("url", "").strip())
        if not href.startswith("http"):
            continue

        link_id = link.get("id", "").lower()
        link_text = link.get("text", "")

        is_primary = link_id in {"sdlink", "hdlink"}
        looks_like_fb_cdn_video = "fbcdn.net" in href and ".mp4" in href.lower()
        if not (is_primary or looks_like_fb_cdn_video):
            continue

        if href in seen_urls:
            continue
        seen_urls.add(href)

        quality = ""
        if link_id == "hdlink" or "hd quality" in link_text.lower():
            quality = "hd"
        elif link_id == "sdlink" or "normal quality" in link_text.lower():
            quality = "sd"
        elif "hd" in link_text.lower():
            quality = "hd"
        elif "sd" in link_text.lower():
            quality = "sd"

        media_links.append(
            {
                "quality": quality or "unknown",
                "label": link_text or link.get("download", ""),
                "url": href,
            }
        )

    return media_links


def fetch_fdown_data(facebook_url: str) -> dict[str, Any]:
    scraper = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "windows", "desktop": True}
    )

    landing = scraper.get(BASE_PAGE_URL, headers=DEFAULT_HEADERS, timeout=30)
    landing.raise_for_status()

    result = scraper.post(
        DOWNLOAD_URL,
        data={"URLz": facebook_url},
        headers=DEFAULT_HEADERS,
        timeout=45,
    )
    result.raise_for_status()

    result_html = result.text
    if "just a moment" in result_html.lower():
        raise FDownError("Blocked by Cloudflare challenge while scraping.")

    media_links = extract_media_links(result_html)
    if not media_links:
        errors = extract_error_messages(result_html)
        if errors:
            raise FDownError(" | ".join(errors))
        raise FDownError("No downloadable Facebook video links found in result.")

    return {
        "status": "ok",
        "input_url": facebook_url,
        "downloader_url": DOWNLOAD_URL,
        "media_links": media_links,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Scrape downloadable Facebook video links from fdown.net"
    )
    parser.add_argument("facebook_url", help="Facebook video/reel/share URL")
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output",
    )
    args = parser.parse_args()

    normalized_url = normalize_facebook_url(args.facebook_url)
    if not normalized_url:
        print(
            json.dumps(
                {"status": "error", "message": "Missing or invalid Facebook URL argument."}
            ),
            file=sys.stderr,
        )
        return 1

    try:
        result = fetch_fdown_data(normalized_url)
    except FDownError as exc:
        print(json.dumps({"status": "error", "message": str(exc)}), file=sys.stderr)
        return 1
    except Exception as exc:  # pragma: no cover
        print(json.dumps({"status": "error", "message": str(exc)}), file=sys.stderr)
        return 1

    if args.pretty:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
