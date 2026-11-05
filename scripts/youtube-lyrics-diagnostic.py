"""Temporary fixed-video diagnostic; stdout contains sanitized JSON only."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys


sys.dont_write_bytecode = True
VIDEO = "BFzh21UKNBk"
SAFE_CODES = {"unsupported_request", "request_limit", "upstream_status", "response_limit"}
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


def probe(helper, yt_music, client):
    summary = {"probe": client, "timedLookup": "skipped", "timedLines": 0}
    session = helper.create_bounded_session()
    try:
        api = yt_music(requests_session=session)
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
            if page_type == "MUSIC_PAGE_TYPE_TRACK_LYRICS" and valid_ref and disabled is not True:
                references.append(reference)
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
            "enabledLyricsRefCount": len(references),
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
        for client in ("default", "minimal"):
            print(json.dumps({"probe": client, **failure(error)}, separators=(",", ":")))
        return 1
    for client in ("default", "minimal"):
        try:
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                result = probe(helper, YTMusic, client)
        except Exception as error:
            result = {"probe": client, **failure(error)}
        print(json.dumps(result, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
