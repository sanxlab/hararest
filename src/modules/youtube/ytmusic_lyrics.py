"""Bounded, anonymous YouTube Music timed-lyrics lookup for one video."""

import json
import math
import re
import sys
from urllib.parse import urlsplit


VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}\Z")
LYRICS_ID = re.compile(r"MPLY[A-Za-z0-9_=-]{1,500}\Z")
# The radio/next payload includes recommendations even when parsed with limit=1.
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
MAX_HTTP_REQUESTS = 4
MAX_LINES = 4000
MAX_TEXT_BYTES = 64 * 1024
MAX_TIME_MS = 3_600_000


class LyricsLookupError(Exception):
    """An operational lookup failure; safe to report without raw details."""


def create_bounded_session():
    # Lazy imports keep this module testable without optional runtime packages.
    import requests

    class BoundedSession(requests.Session):
        def __init__(self):
            super().__init__()
            # Do not load account credentials from .netrc or environment proxies.
            self.trust_env = False
            self.auth = None
            self.request_count = 0

        def request(self, method, url, **kwargs):
            parsed = urlsplit(url)
            method = method.upper()
            allowed = (
                parsed.scheme == "https"
                and parsed.hostname == "music.youtube.com"
                and parsed.port in (None, 443)
                and parsed.username is None
                and parsed.password is None
                and (
                    (method == "GET" and parsed.path in ("", "/"))
                    or (
                        method == "POST"
                        and parsed.path in ("/youtubei/v1/next", "/youtubei/v1/browse")
                    )
                )
            )
            headers = kwargs.get("headers") or {}
            if (
                not allowed
                or kwargs.get("auth") is not None
                or any(str(key).lower() == "authorization" for key in headers)
            ):
                raise ValueError("unsupported_request")
            self.request_count += 1
            if self.request_count > MAX_HTTP_REQUESTS:
                raise ValueError("request_limit")
            kwargs.update(timeout=(2, 3), allow_redirects=False, stream=True)
            response = super().request(method, url, **kwargs)
            try:
                if not 200 <= response.status_code < 300:
                    raise ValueError("upstream_status")
                try:
                    declared = int(response.headers.get("Content-Length", "0"))
                except ValueError:
                    declared = 0
                if declared > MAX_RESPONSE_BYTES:
                    raise ValueError("response_limit")
                chunks = []
                size = 0
                # iter_content applies decompression, so the cap covers gzip too.
                for chunk in response.iter_content(64 * 1024):
                    size += len(chunk)
                    if size > MAX_RESPONSE_BYTES:
                        raise ValueError("response_limit")
                    chunks.append(chunk)
                response._content = b"".join(chunks)
                response._content_consumed = True
                return response
            finally:
                response.close()

    return BoundedSession()


def validated_lines(result):
    if not isinstance(result, dict) or result.get("hasTimestamps") is not True:
        return []
    raw = result.get("lyrics")
    if not isinstance(raw, list) or not raw or len(raw) > MAX_LINES:
        return []
    lines = []
    size = 0
    previous = -1
    for line in raw:
        if isinstance(line, dict):
            start, text = line.get("start_time"), line.get("text")
        else:
            start, text = getattr(line, "start_time", None), getattr(line, "text", None)
        if not isinstance(start, (int, float)) or isinstance(start, bool):
            return []
        if isinstance(start, float) and (not math.isfinite(start) or not start.is_integer()):
            return []
        if start < 0 or start > MAX_TIME_MS or start < previous or not isinstance(text, str):
            return []
        if "\0" in text:
            return []
        text = " ".join(text.splitlines()).strip()
        try:
            size += len(text.encode("utf-8"))
        except UnicodeEncodeError:
            return []
        if size > MAX_TEXT_BYTES:
            return []
        previous = int(start)
        lines.append({"timeMs": int(start), "text": text})
    return lines if any(line["text"] for line in lines) else []


def fetch_timed_lyrics(video_id, api=None):
    if not isinstance(video_id, str) or VIDEO_ID.fullmatch(video_id) is None:
        return {"videoId": "", "lines": []}

    def empty(reason):
        # Fixed diagnostic codes only; never return upstream content or IDs.
        return {"videoId": video_id, "lines": [], "reason": reason}

    session = None
    try:
        if api is None:
            from ytmusicapi import YTMusic

            session = create_bounded_session()
            api = YTMusic(requests_session=session)
        watch = api.get_watch_playlist(videoId=video_id, limit=1)
        if not isinstance(watch, dict):
            return empty("watch_invalid")
        tracks = watch.get("tracks")
        if (
            not isinstance(tracks, list)
            or not tracks
            or not isinstance(tracks[0], dict)
        ):
            return empty("watch_invalid")
        if tracks[0].get("videoId") != video_id:
            return empty("video_mismatch")
        browse_id = watch.get("lyrics")
        if browse_id is None or browse_id == "":
            return empty("lyrics_ref_missing")
        if not isinstance(browse_id, str) or LYRICS_ID.fullmatch(browse_id) is None:
            return empty("lyrics_ref_invalid")
        result = api.get_lyrics(browse_id, timestamps=True)
        if result is None:
            return empty("no_lyrics")
        if isinstance(result, dict):
            if result.get("hasTimestamps") is False:
                return empty("untimed")
            if result.get("hasTimestamps") is True and result.get("lyrics") == []:
                return empty("no_lyrics")
        lines = validated_lines(result)
        if not lines:
            return empty("invalid_lines")
        return {"videoId": video_id, "lines": lines}
    except Exception:
        # Distinguish outages from a legitimate miss, so the parent does not
        # cache transient failures. Never expose the original exception.
        raise LyricsLookupError("lookup_failed") from None
    finally:
        if session is not None:
            session.close()


def main(argv=None):
    arguments = sys.argv[1:] if argv is None else argv
    video_id = arguments[0] if len(arguments) == 1 else ""
    exit_code = 0
    try:
        result = fetch_timed_lyrics(video_id)
    except Exception:
        result = {"videoId": video_id if VIDEO_ID.fullmatch(video_id) else "", "lines": []}
        exit_code = 1
    sys.stdout.write(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n")
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
