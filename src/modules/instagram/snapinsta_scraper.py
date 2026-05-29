#!/usr/bin/env python3
"""Scrape downloadable media links from snapinsta.to for an Instagram URL."""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Any
from urllib.parse import unquote

import cloudscraper


BASE_PAGE_URL = "https://snapinsta.to/en2"
DEFAULT_SEARCH_URL = "https://snapinsta.to/api/ajaxSearch"
USERVERIFY_URL = "https://snapinsta.to/api/userverify"
BASE_DIGITS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ+/"

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/137.0.0.0 Safari/537.36"
    ),
    "Origin": "https://snapinsta.to",
    "Referer": BASE_PAGE_URL,
}


class SnapInstaError(RuntimeError):
    """Raised when SnapInsta returns an error or unsupported response format."""


@dataclass
class PageConfig:
    search_url: str
    lang: str
    ver: str


class DownloadLinkParser(HTMLParser):
    """Collect anchor tags that point to downloadable media links."""

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
        cls = attr_map.get("class", "")
        if not href:
            return

        self._current = {
            "url": href,
            "title": attr_map.get("title", "").strip(),
            "class": cls,
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


def extract_var(html_text: str, name: str, default: str) -> str:
    pattern = rf"{re.escape(name)}\s*=\s*['\"]([^'\"]+)['\"]"
    match = re.search(pattern, html_text)
    return match.group(1) if match else default


def parse_page_config(html_text: str) -> PageConfig:
    return PageConfig(
        search_url=extract_var(html_text, "k_url_search", DEFAULT_SEARCH_URL),
        lang=extract_var(html_text, "k_lang", "en"),
        ver=extract_var(html_text, "k_ver", "v2"),
    )


def strip_tags(text: str) -> str:
    cleaned = re.sub(r"<[^>]+>", "", text)
    return html.unescape(" ".join(cleaned.split()))


def base_to_int(value: str, base: int) -> int:
    if base < 2 or base > len(BASE_DIGITS):
        raise ValueError(f"Unsupported base: {base}")

    alphabet = BASE_DIGITS[:base]
    total = 0
    for power, char in enumerate(reversed(value)):
        total += alphabet.index(char) * (base**power)
    return total


def decode_v2_payload(data_js: str) -> str:
    """Decode SnapInsta v2 packed payload into plain JavaScript."""

    packed_re = re.compile(
        r'eval\(function\(h,u,n,t,e,r\)\{.*?\}\("(?P<h>.*?)",\s*(?P<u>\d+),\s*"(?P<n>.*?)",\s*(?P<t>\d+),\s*(?P<e>\d+),\s*(?P<r>\d+)\)\)',
        re.S,
    )
    match = packed_re.search(data_js)
    if not match:
        raise SnapInstaError("Unsupported encrypted payload format.")

    encoded = match.group("h")
    symbol_alphabet = match.group("n")
    shift = int(match.group("t"))
    base = int(match.group("e"))

    if base >= len(symbol_alphabet):
        raise SnapInstaError("Invalid encrypted payload alphabet.")

    delimiter = symbol_alphabet[base]
    decoded_chars: list[str] = []
    cursor = 0

    while cursor < len(encoded):
        token_chars: list[str] = []
        while cursor < len(encoded) and encoded[cursor] != delimiter:
            token_chars.append(encoded[cursor])
            cursor += 1
        cursor += 1  # skip delimiter

        if not token_chars:
            continue

        token = "".join(token_chars)
        for index, symbol in enumerate(symbol_alphabet):
            token = token.replace(symbol, str(index))

        char_code = base_to_int(token, base) - shift
        decoded_chars.append(chr(char_code))

    return unquote("".join(decoded_chars))


def extract_inner_html(decoded_js: str) -> str:
    match = re.search(
        r'innerHTML\s*=\s*"((?:\\.|[^"\\])*)";',
        decoded_js,
        re.S,
    )
    if not match:
        raise SnapInstaError("Could not find HTML content in decoded payload.")

    raw_js_string = match.group(1)
    try:
        return json.loads(f'"{raw_js_string}"')
    except json.JSONDecodeError as exc:
        raise SnapInstaError("Failed to decode HTML string from payload.") from exc


def extract_media_links(result_html: str) -> list[dict[str, str]]:
    parser = DownloadLinkParser()
    parser.feed(result_html)

    media_links: list[dict[str, str]] = []
    for link in parser.links:
        href = link.get("url", "")
        cls = set(link.get("class", "").split())
        text = link.get("text", "")
        title = link.get("title", "")

        if not href.startswith("http"):
            continue
        if "abutton" not in cls:
            continue

        media_links.append(
            {
                "url": href,
                "text": text,
                "title": title,
            }
        )
    return media_links


def fetch_snapinsta_data(instagram_url: str) -> dict[str, Any]:
    scraper = cloudscraper.create_scraper(
        browser={"browser": "chrome", "platform": "windows", "desktop": True}
    )

    landing = scraper.get(BASE_PAGE_URL, headers=DEFAULT_HEADERS, timeout=30)
    landing.raise_for_status()
    page_config = parse_page_config(landing.text)

    verify = scraper.post(
        USERVERIFY_URL,
        data={"url": instagram_url},
        headers={**DEFAULT_HEADERS, "X-Requested-With": "XMLHttpRequest"},
        timeout=30,
    )
    verify.raise_for_status()

    verify_json = verify.json()
    token = verify_json.get("token", "")
    if not token:
        raise SnapInstaError("Failed to get authentication token from SnapInsta.")

    payload = {
        "q": instagram_url,
        "t": "media",
        "v": page_config.ver,
        "lang": page_config.lang,
        "cftoken": token,
    }
    search = scraper.post(
        page_config.search_url,
        data=payload,
        headers=DEFAULT_HEADERS,
        timeout=45,
    )
    search.raise_for_status()

    try:
        data = search.json()
    except ValueError as exc:
        if "just a moment" in search.text.lower():
            raise SnapInstaError("Blocked by Cloudflare challenge while scraping.") from exc
        raise SnapInstaError("SnapInsta response is not valid JSON.") from exc

    if data.get("mess"):
        raise SnapInstaError(strip_tags(data["mess"]))

    if data.get("status") != "ok":
        raise SnapInstaError(f"Unexpected status: {data.get('status')}")

    payload_js = data.get("data", "")
    if not payload_js:
        raise SnapInstaError("SnapInsta returned no downloadable payload.")

    if data.get("v") == "v2":
        decoded_js = decode_v2_payload(payload_js)
        result_html = extract_inner_html(decoded_js)
    else:
        result_html = payload_js

    media_links = extract_media_links(result_html)
    if not media_links:
        raise SnapInstaError("No media download links found in SnapInsta result.")

    return {
        "input_url": instagram_url,
        "snapinsta_search_url": page_config.search_url,
        "status": "ok",
        "media_links": media_links,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Scrape downloadable media links from snapinsta.to"
    )
    parser.add_argument("instagram_url", help="Instagram post/reel URL")
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output",
    )
    args = parser.parse_args()

    try:
        result = fetch_snapinsta_data(args.instagram_url.strip())
    except SnapInstaError as exc:
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
