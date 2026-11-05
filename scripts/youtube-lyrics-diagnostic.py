"""Temporary fixed-video diagnostic; stdout contains sanitized JSON only."""

import base64
import contextlib
import importlib.util
import io
import json
import math
from pathlib import Path
import re
import sys
import unicodedata
import urllib.parse
import urllib.request


sys.dont_write_bytecode = True
VIDEO = "BFzh21UKNBk"
PROBES = ("default", "minimal", "mobile_minimal", "mobile_id", "kugou")
SAFE_CODES = {"unsupported_request", "request_limit", "upstream_status", "response_limit", "invalid_response"}
SAFE_ERRORS = {
    "AttributeError", "ConnectionError", "ConnectTimeout", "FileNotFoundError",
    "ImportError", "JSONDecodeError", "KeyError", "LyricsLookupError",
    "ModuleNotFoundError", "ReadTimeout", "Timeout", "TimeoutError", "TypeError",
    "ValueError", "YTMusicServerError", "YTMusicUserError",
}


def failure(error):
    name = type(error).__name__
    result = {"errorType": name if name in SAFE_ERRORS else "OtherError"}
    code = error.args[0] if len(error.args) == 1 else None
    if isinstance(code, str) and code in SAFE_CODES:
        result["errorCode"] = code
    return result


def at(value, *keys):
    for key in keys:
        if not isinstance(value, dict):
            return None
        value = value.get(key)
    return value


def probe_kugou():
    summary = {
        "probe": "kugou", "candidateCount": 0, "exactCandidateCount": 0,
        "durationMs": 0, "timedLines": 0, "hasTimestamps": False,
        "timedLookup": "empty",
    }
    try:
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None

        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

        def request(endpoint, parameters):
            url = "https://lyrics.kugou.com/" + endpoint + "?" + urllib.parse.urlencode(parameters)
            with opener.open(urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"}), timeout=5) as response:
                data = response.read(256 * 1024 + 1)
            if len(data) > 256 * 1024:
                raise ValueError("response_limit")
            result = json.loads(data)
            if not isinstance(result, dict):
                raise ValueError("invalid_response")
            return result

        def normalized(value):
            if not isinstance(value, str):
                return ""
            return "".join(character for character in unicodedata.normalize("NFKC", value).casefold()
                           if character.isalnum())

        data = request("search", {
            "ver": 1, "man": "yes", "client": "pc",
            "keyword": "Chloe Pawapua - Jadian Yuk", "duration": 155000,
        })
        candidates = data.get("candidates")
        if not isinstance(candidates, list):
            raise ValueError("invalid_response")
        summary["candidateCount"] = len(candidates)
        matches = []
        for candidate in candidates:
            if not isinstance(candidate, dict):
                continue
            duration = candidate.get("duration")
            if (type(duration) not in (int, float) or not math.isfinite(duration)
                    or not float(duration).is_integer() or abs(duration - 155000) > 2000):
                continue
            if (normalized(candidate.get("song")) == normalized("Jadian Yuk")
                    and normalized(candidate.get("singer")) == normalized("Chloe Pawapua")):
                matches.append(candidate)
        summary["exactCandidateCount"] = len(matches)
        if not matches:
            return summary
        candidate = matches[0]
        summary["durationMs"] = int(candidate["duration"])
        identifier, access = candidate.get("id"), candidate.get("accesskey")
        if (not isinstance(identifier, str) or re.fullmatch(r"[0-9]{1,30}", identifier) is None
                or not isinstance(access, str) or not 0 < len(access) <= 256):
            raise ValueError("invalid_response")
        data = request("download", {
            "ver": 1, "client": "pc", "id": identifier, "accesskey": access,
            "fmt": "lrc", "charset": "utf8",
        })
        content = data.get("content")
        if content is None or content == "":
            return summary
        if not isinstance(content, str) or len(content) > 128 * 1024:
            raise ValueError("invalid_response")
        lyrics = base64.b64decode(content, validate=True).decode("utf-8-sig")
        timestamp = re.compile(r"\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]")
        times = []
        for line in lyrics.splitlines():
            position = 0
            line_times = []
            while match := timestamp.match(line, position):
                fraction = (match.group(3) or "").ljust(3, "0")
                line_times.append(int(match.group(1)) * 60000 + int(match.group(2)) * 1000
                                  + int(fraction or "0"))
                position = match.end()
            if line_times and line[position:].strip():
                times.extend(line_times)
        valid = (2 <= len(times) <= 4000 and len(set(times)) >= 2
                 and min(times) >= 0 and max(times) <= summary["durationMs"] + 2000)
        summary.update({
            "hasTimestamps": valid, "timedLines": len(times) if valid else 0,
            "timedLookup": "found" if valid else "untimed",
        })
    except Exception as error:
        summary.update(failure(error))
        summary["timedLookup"] = "failed"
    return summary


def probe(helper, yt_music, client):
    summary = {"probe": client, "timedLookup": "skipped", "timedLines": 0}
    session = helper.create_bounded_session()
    try:
        api = yt_music(requests_session=session, location="ID" if client == "mobile_id" else "")
        body = {"videoId": VIDEO}
        if client == "default":
            body.update({
                "enablePersistentPlaylistPanel": True,
                "isAudioOnly": True,
                "tunerSettingValue": "AUTOMIX_SETTING_NORMAL",
                "playlistId": "RDAMVM" + VIDEO,
                "watchEndpointMusicSupportedConfigs": {"watchEndpointMusicConfig": {
                    "hasPersistentPlaylistPanel": True,
                    "musicVideoType": "MUSIC_VIDEO_TYPE_ATV",
                }},
            })
        if client in ("mobile_minimal", "mobile_id"):
            with api.as_mobile():
                response = api._send_request("next", body)
        else:
            response = api._send_request("next", body)
        current = at(response, "currentVideoEndpoint", "watchEndpoint", "videoId")
        tabs = at(response, "contents", "singleColumnMusicWatchNextResultsRenderer",
                  "tabbedRenderer", "watchNextTabbedResultsRenderer", "tabs")
        summary.update({
            "currentEndpointPresent": isinstance(current, str),
            "currentEndpointMatches": current == VIDEO,
            "tabsAreList": isinstance(tabs, list),
            "tabCount": len(tabs) if isinstance(tabs, list) else 0,
        })
        selected = []
        references = []
        disabled_references = 0
        tab_shapes = []
        for tab in tabs if isinstance(tabs, list) else []:
            renderer = at(tab, "tabRenderer")
            endpoint = at(renderer, "endpoint", "browseEndpoint")
            page_type = at(endpoint, "browseEndpointContextSupportedConfigs",
                           "browseEndpointContextMusicConfig", "pageType")
            reference = at(endpoint, "browseId")
            valid_ref = isinstance(reference, str) and helper.LYRICS_ID.fullmatch(reference) is not None
            disabled = at(renderer, "unselectable")
            shape = {
                "rendererValid": isinstance(renderer, dict),
                "unselectablePresent": isinstance(renderer, dict) and "unselectable" in renderer,
                "unselectableIsTrue": disabled is True,
                "unselectableIsFalse": disabled is False,
                "pageType": ({
                    "MUSIC_PAGE_TYPE_TRACK_LYRICS": "lyrics",
                    "MUSIC_PAGE_TYPE_TRACK_RELATED": "related",
                }.get(page_type, "other") if isinstance(page_type, str) else "missing"),
                "refPresent": isinstance(endpoint, dict) and "browseId" in endpoint,
                "refValid": valid_ref,
            }
            if len(tab_shapes) < 8:
                tab_shapes.append(shape)
            if page_type == "MUSIC_PAGE_TYPE_TRACK_LYRICS" and valid_ref:
                references.append(reference)
                disabled_references += disabled is True
            queue = at(renderer, "content", "musicQueueRenderer", "content",
                       "playlistPanelRenderer", "contents")
            for item in queue if isinstance(queue, list) else []:
                primary = at(item, "playlistPanelVideoRenderer")
                if primary is None:
                    primary = at(item, "playlistPanelVideoWrapperRenderer", "primaryRenderer",
                                 "playlistPanelVideoRenderer")
                if at(primary, "selected") is True:
                    selected.append(at(primary, "videoId") == VIDEO)
        summary.update({
            "tabs": tab_shapes,
            "tabsOmitted": max(0, summary["tabCount"] - len(tab_shapes)),
            "selectedPrimaryCount": len(selected),
            "selectedPrimaryMatches": selected.count(True),
            "selectedPrimaryMismatches": selected.count(False),
            "enabledLyricsRefCount": len(references) - disabled_references,
            "lyricsRefCount": len(references),
            "disabledLyricsRefCount": disabled_references,
        })
        if current == VIDEO and selected == [True] and len(references) == 1:
            result = api.get_lyrics(references[0], timestamps=True)
            timed = isinstance(result, dict) and result.get("hasTimestamps") is True
            count = len(helper.validated_lines(result))
            summary.update({
                "hasTimestamps": timed,
                "timedLines": count,
                "timedLookup": "found" if count else "empty" if timed or result is None else "untimed",
            })
    except Exception as error:
        summary.update(failure(error))
        summary["timedLookup"] = "failed"
    finally:
        summary["httpRequests"] = session.request_count
        session.close()
    return summary


def main():
    try:
        # The existing Heroku image has the fixed /app path. Local execution
        # resolves only this repository, with no caller-provided import path.
        helper_path = Path("/app/src/modules/youtube/ytmusic_lyrics.py")
        if not helper_path.is_file():
            root = Path(__file__).resolve().parents[1] if "__file__" in globals() else Path.cwd()
            helper_path = root / "src/modules/youtube/ytmusic_lyrics.py"
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            spec = importlib.util.spec_from_file_location("ytmusic_lyrics_diagnostic_helper", helper_path)
            helper = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(helper)
            from ytmusicapi import YTMusic
    except Exception as error:
        for client in PROBES:
            print(json.dumps({"probe": client, **failure(error)}, separators=(",", ":")))
        return 1
    for client in PROBES:
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                result = probe_kugou() if client == "kugou" else probe(helper, YTMusic, client)
        except Exception as error:
            result = {"probe": client, **failure(error)}
        print(json.dumps(result, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
