"""Bounded YouTube Music lookup with separate web and mobile clients."""

import json
import math
import os
import http.cookiejar
import re
import sys
from urllib.parse import urlsplit


VIDEO_ID = re.compile(r"[A-Za-z0-9_-]{11}\Z")
LYRICS_ID = re.compile(r"MPLY[A-Za-z0-9_=-]{1,500}\Z")
# The radio/next payload includes recommendations even when parsed with limit=1.
MAX_RESPONSE_BYTES = 4 * 1024 * 1024
# Authenticated web next plus mobile visitor/next/browse needs at most five.
MAX_HTTP_REQUESTS = 5
MAX_LINES = 4000
MAX_TEXT_BYTES = 64 * 1024
MAX_TIME_MS = 3_600_000


class LyricsLookupError(Exception):
    """An operational lookup failure; safe to report without raw details."""


def browser_auth_from_cookie_file(filename):
    if not filename:
        return None
    try:
        if os.stat(filename).st_size > 65536:
            return None
        jar = http.cookiejar.MozillaCookieJar(filename)
        jar.load(ignore_discard=True)
        cookies = {}
        for cookie in jar:
            if (cookie.domain.lstrip('.') not in ('youtube.com', 'music.youtube.com')
                    or cookie.path != '/' or cookie.is_expired()
                    or not re.fullmatch(r'[A-Za-z0-9_-]+', cookie.name)
                    or not re.fullmatch(r'[\x21-\x3a\x3c-\x7e]+', cookie.value)):
                continue
            cookies[cookie.name] = cookie.value
        if '__Secure-3PAPISID' not in cookies:
            return None
        from ytmusicapi.helpers import initialize_headers, get_authorization
        headers = initialize_headers()
        headers.update({
            'cookie': '; '.join(name + '=' + value for name, value in cookies.items()),
            'authorization': get_authorization(cookies['__Secure-3PAPISID'] + ' https://music.youtube.com'),
            'x-goog-authuser': '0',
        })
        return dict(headers)
    except Exception:
        return None


def create_bounded_session(browser_auth=False):
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
                or any(str(key).lower() == "authorization" and (
                    not browser_auth or re.fullmatch(r'SAPISIDHASH \d+_[a-f0-9]{40}', str(value)) is None
                ) for key, value in headers.items())
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


def _dict_path(value, *keys):
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def _fallback_lyrics_reference(response, video_id):
    # A minimal mobile next response can expose the tab omitted by the radio
    # response. Accept only a server-issued reference tied to this exact video.
    if _dict_path(response, "currentVideoEndpoint", "watchEndpoint", "videoId") != video_id:
        return None
    tabs = _dict_path(
        response, "contents", "singleColumnMusicWatchNextResultsRenderer",
        "tabbedRenderer", "watchNextTabbedResultsRenderer", "tabs",
    )
    if not isinstance(tabs, list):
        return None
    selected = []
    references = []
    for tab in tabs:
        renderer = _dict_path(tab, "tabRenderer")
        if not isinstance(renderer, dict):
            return None
        queue = _dict_path(
            renderer, "content", "musicQueueRenderer", "content",
            "playlistPanelRenderer", "contents",
        )
        if queue is not None:
            if not isinstance(queue, list):
                return None
            for item in queue:
                track = _dict_path(item, "playlistPanelVideoRenderer")
                if track is None:
                    track = _dict_path(
                        item, "playlistPanelVideoWrapperRenderer", "primaryRenderer",
                        "playlistPanelVideoRenderer",
                    )
                if isinstance(track, dict) and track.get("selected") is True:
                    selected.append(track.get("videoId"))
        # The unselectable UI flag alone does not determine the browse payload;
        # fetch_timed_lyrics validates the actual lyrics result separately.
        endpoint = _dict_path(renderer, "endpoint", "browseEndpoint")
        page_type = _dict_path(
            endpoint, "browseEndpointContextSupportedConfigs",
            "browseEndpointContextMusicConfig", "pageType",
        )
        if page_type == "MUSIC_PAGE_TYPE_TRACK_LYRICS":
            reference = endpoint.get("browseId")
            if not isinstance(reference, str) or LYRICS_ID.fullmatch(reference) is None:
                return None
            references.append(reference)
    if selected != [video_id] or len(references) != 1:
        return None
    return references[0]


def fetch_timed_lyrics(video_id, api=None):
    if not isinstance(video_id, str) or VIDEO_ID.fullmatch(video_id) is None:
        return {"videoId": "", "lines": []}

    def empty(reason):
        # Fixed diagnostic codes only; never return upstream content or IDs.
        return {"videoId": video_id, "lines": [], "reason": reason}

    session = None
    auth = None
    try:
        if api is None:
            from ytmusicapi import YTMusic

            auth = browser_auth_from_cookie_file(os.environ.get('HARAREST_YTMUSIC_COOKIE_PATH'))
            session = create_bounded_session(browser_auth=bool(auth))
            api = YTMusic(auth=auth, requests_session=session)
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
        # Browser SAPISID authentication cannot be mixed into Android browse:
        # Google returns INVALID_ARGUMENT. Keep the issued reference, but use
        # an independent mobile client without the web authentication headers.
        # The same transport enforces one total request/response budget.
        lyrics_api = YTMusic(requests_session=session) if auth else api
        browse_id = watch.get("lyrics")
        if browse_id is None or browse_id == "":
            # Isolate the pinned ytmusicapi 1.12.3 mobile context and request
            # adapter. A minimal body avoids forcing radio/ATV parameters.
            with lyrics_api.as_mobile():
                response = lyrics_api._send_request("next", {"videoId": video_id})
            browse_id = _fallback_lyrics_reference(response, video_id)
            if browse_id is None:
                return empty("lyrics_ref_missing")
        if not isinstance(browse_id, str) or LYRICS_ID.fullmatch(browse_id) is None:
            return empty("lyrics_ref_invalid")
        result = lyrics_api.get_lyrics(browse_id, timestamps=True)
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
