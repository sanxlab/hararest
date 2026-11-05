"""Offline trust-boundary tests for the optional YouTube Music helper."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest
import tempfile
from unittest.mock import MagicMock, patch


sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location(
    "ytmusic_lyrics", ROOT / "src/modules/youtube/ytmusic_lyrics.py"
)
helper = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(helper)
VIDEO = "BFzh21UKNBk"
REF = "MPLYfixture-lyrics="


def timed(lines=None):
    return {
        "hasTimestamps": True,
        "lyrics": lines if lines is not None else [
            types.SimpleNamespace(start_time=1200, text="検証用の架空の文章"),
            types.SimpleNamespace(start_time=2500, text="Another original fixture line"),
        ],
    }


def watch_next(current_video=VIDEO, selected_videos=None, reference=REF, unselectable=False):
    queue = [{"playlistPanelVideoRenderer": {"videoId": "SVkGRoLicuA", "selected": False}}]
    queue.extend({"playlistPanelVideoRenderer": {"videoId": video_id, "selected": True}}
                 for video_id in ([VIDEO] if selected_videos is None else selected_videos))
    tabs = [
        {"tabRenderer": {"content": {"musicQueueRenderer": {"content": {
            "playlistPanelRenderer": {"contents": queue},
        }}}}},
        {"tabRenderer": {"unselectable": unselectable, "endpoint": {"browseEndpoint": {
            "browseId": reference,
            "browseEndpointContextSupportedConfigs": {"browseEndpointContextMusicConfig": {
                "pageType": "MUSIC_PAGE_TYPE_TRACK_LYRICS",
            }},
        }}}},
    ]
    return {
        "currentVideoEndpoint": {"watchEndpoint": {"videoId": current_video}},
        "contents": {"singleColumnMusicWatchNextResultsRenderer": {"tabbedRenderer": {
            "watchNextTabbedResultsRenderer": {"tabs": tabs},
        }}},
    }


def next_tabs(response):
    return response["contents"]["singleColumnMusicWatchNextResultsRenderer"]["tabbedRenderer"]["watchNextTabbedResultsRenderer"]["tabs"]


class LookupTests(unittest.TestCase):
    def setUp(self):
        self.api = MagicMock()
        self.api.get_watch_playlist.return_value = {
            "tracks": [{"videoId": VIDEO}], "lyrics": REF,
        }
        self.api.get_lyrics.return_value = timed()
        self.api._send_request.return_value = None
        self.web_context = {"client": {"clientName": "WEB_REMIX"}}
        self.api.context = self.web_context

        @contextlib.contextmanager
        def as_mobile():
            previous = self.api.context
            self.api.context = {"client": {"clientName": "ANDROID_MUSIC"}}
            try:
                yield
            finally:
                self.api.context = previous

        self.api.as_mobile.side_effect = as_mobile

    def test_matches_same_video_and_uses_actual_timestamps(self):
        result = helper.fetch_timed_lyrics(VIDEO, self.api)
        self.assertEqual(result, {
            "videoId": VIDEO,
            "lines": [
                {"timeMs": 1200, "text": "検証用の架空の文章"},
                {"timeMs": 2500, "text": "Another original fixture line"},
            ],
        })
        self.api.get_watch_playlist.assert_called_once_with(videoId=VIDEO, limit=1)
        self.api.get_lyrics.assert_called_once_with(REF, timestamps=True)
        self.api._send_request.assert_not_called()
        self.api.as_mobile.assert_not_called()

    def test_minimal_mobile_next_recovers_exact_video_and_restores_context_before_lyrics(self):
        def next_response(endpoint, body):
            self.assertEqual(self.api.context["client"]["clientName"], "ANDROID_MUSIC")
            self.assertEqual((endpoint, body), ("next", {"videoId": VIDEO}))
            return watch_next()

        def lyrics_response(reference, timestamps):
            self.assertIs(self.api.context, self.web_context)
            self.assertEqual((reference, timestamps), (REF, True))
            return timed()

        self.api._send_request.side_effect = next_response
        self.api.get_lyrics.side_effect = lyrics_response
        for missing in (None, ""):
            with self.subTest(missing=missing):
                self.api.reset_mock()
                self.api.get_watch_playlist.return_value["lyrics"] = missing
                result = helper.fetch_timed_lyrics(VIDEO, self.api)
                self.assertEqual(result["lines"], [
                    {"timeMs": 1200, "text": "検証用の架空の文章"},
                    {"timeMs": 2500, "text": "Another original fixture line"},
                ])
                self.api.get_watch_playlist.assert_called_once_with(videoId=VIDEO, limit=1)
                self.api.as_mobile.assert_called_once_with()
                self.api._send_request.assert_called_once_with("next", {"videoId": VIDEO})
                self.api.get_lyrics.assert_called_once_with(REF, timestamps=True)
                self.assertIs(self.api.context, self.web_context)

    def test_fallback_accepts_a_selected_primary_wrapper_and_ignores_counterparts(self):
        response = watch_next()
        queue = next_tabs(response)[0]["tabRenderer"]["content"]["musicQueueRenderer"]["content"]["playlistPanelRenderer"]["contents"]
        queue[1] = {"playlistPanelVideoWrapperRenderer": {
            "primaryRenderer": queue[1],
            "counterpart": [{"counterpartRenderer": {"playlistPanelVideoRenderer": {
                "videoId": "SVkGRoLicuA", "selected": True,
            }}}],
        }}
        self.api.get_watch_playlist.return_value["lyrics"] = None
        self.api._send_request.return_value = response
        self.assertEqual(len(helper.fetch_timed_lyrics(VIDEO, self.api)["lines"]), 2)
        self.api.get_lyrics.assert_called_once_with(REF, timestamps=True)

    def test_unselectable_reference_accepts_actual_timestamps_for_the_exact_video(self):
        self.api.get_watch_playlist.return_value["lyrics"] = None
        self.api._send_request.return_value = watch_next(unselectable=True)
        self.assertEqual(helper.fetch_timed_lyrics(VIDEO, self.api), {
            "videoId": VIDEO,
            "lines": [
                {"timeMs": 1200, "text": "検証用の架空の文章"},
                {"timeMs": 2500, "text": "Another original fixture line"},
            ],
        })
        self.api.get_lyrics.assert_called_once_with(REF, timestamps=True)

    def test_unselectable_reference_still_requires_a_valid_timed_payload(self):
        self.api.get_watch_playlist.return_value["lyrics"] = None
        self.api._send_request.return_value = watch_next(unselectable=True)
        for result, reason in (
            (None, "no_lyrics"),
            ({"hasTimestamps": True, "lyrics": []}, "no_lyrics"),
            ({"hasTimestamps": False, "lyrics": "original fixture text"}, "untimed"),
            ({"lyrics": []}, "invalid_lines"),
        ):
            with self.subTest(reason=reason):
                self.api.reset_mock()
                self.api.get_lyrics.return_value = result
                self.assertEqual(helper.fetch_timed_lyrics(VIDEO, self.api), {
                    "videoId": VIDEO, "lines": [], "reason": reason,
                })
                self.api.get_lyrics.assert_called_once_with(REF, timestamps=True)

    def test_unselectable_flag_does_not_replace_a_valid_endpoint_or_video_identity(self):
        missing_endpoint = watch_next(unselectable=True)
        next_tabs(missing_endpoint)[1]["tabRenderer"].pop("endpoint")
        for response in (
            missing_endpoint,
            watch_next(reference=None, unselectable=True),
            watch_next(reference="https://attacker.example/private", unselectable=True),
            watch_next(current_video="SVkGRoLicuA", unselectable=True),
            watch_next(selected_videos=["SVkGRoLicuA"], unselectable=True),
        ):
            with self.subTest(response=response):
                self.api.get_watch_playlist.return_value["lyrics"] = None
                self.api._send_request.return_value = response
                self.assertEqual(helper.fetch_timed_lyrics(VIDEO, self.api), {
                    "videoId": VIDEO, "lines": [], "reason": "lyrics_ref_missing",
                })
        self.api.get_lyrics.assert_not_called()

    def test_fallback_rejects_wrong_or_ambiguous_video_identity(self):
        missing_current = watch_next()
        del missing_current["currentVideoEndpoint"]
        for response in (
            watch_next(current_video="SVkGRoLicuA"),
            missing_current,
            watch_next(selected_videos=["SVkGRoLicuA"]),
            watch_next(selected_videos=[]),
            watch_next(selected_videos=[VIDEO, VIDEO]),
            watch_next(selected_videos=[VIDEO, "SVkGRoLicuA"]),
        ):
            with self.subTest(response=response):
                self.api.get_watch_playlist.return_value["lyrics"] = None
                self.api._send_request.return_value = response
                self.assertEqual(helper.fetch_timed_lyrics(VIDEO, self.api), {
                    "videoId": VIDEO, "lines": [], "reason": "lyrics_ref_missing",
                })
        self.api.get_lyrics.assert_not_called()

    def test_fallback_rejects_duplicate_or_malformed_lyrics_navigation(self):
        duplicate, wrong_type, nested_only = (watch_next() for _ in range(3))
        next_tabs(duplicate).append(next_tabs(duplicate)[1])
        next_tabs(wrong_type)[1]["tabRenderer"]["endpoint"]["browseEndpoint"]["browseEndpointContextSupportedConfigs"]["browseEndpointContextMusicConfig"]["pageType"] = "MUSIC_PAGE_TYPE_TRACK_RELATED"
        endpoint = next_tabs(nested_only)[1]["tabRenderer"].pop("endpoint")
        next_tabs(nested_only)[1]["tabRenderer"]["menu"] = {"arbitraryNestedEndpoint": endpoint}
        malformed_tab = watch_next()
        next_tabs(malformed_tab).append(None)
        malformed_queue = watch_next()
        next_tabs(malformed_queue)[0]["tabRenderer"]["content"]["musicQueueRenderer"]["content"]["playlistPanelRenderer"]["contents"] = "wrong"
        for response in (
            None, {}, duplicate, wrong_type, nested_only, malformed_tab, malformed_queue,
            watch_next(reference=None), watch_next(reference=""),
            watch_next(reference="https://attacker.example/private"),
            watch_next(reference="MPLY" + "x" * 501),
        ):
            with self.subTest(response=response):
                self.api.get_watch_playlist.return_value["lyrics"] = None
                self.api._send_request.return_value = response
                self.assertEqual(helper.fetch_timed_lyrics(VIDEO, self.api), {
                    "videoId": VIDEO, "lines": [], "reason": "lyrics_ref_missing",
                })
        self.api.get_lyrics.assert_not_called()

    def test_fallback_network_errors_remain_operational_failures(self):
        self.api.get_watch_playlist.return_value["lyrics"] = None

        def failed_request(endpoint, body):
            self.assertEqual(self.api.context["client"]["clientName"], "ANDROID_MUSIC")
            raise TimeoutError("private-cookie-secret")

        self.api._send_request.side_effect = failed_request
        with self.assertRaisesRegex(helper.LyricsLookupError, "^lookup_failed$"):
            helper.fetch_timed_lyrics(VIDEO, self.api)
        self.api.as_mobile.assert_called_once_with()
        self.assertIs(self.api.context, self.web_context)
        self.api.get_lyrics.assert_not_called()

    def test_does_not_pick_lyrics_from_a_different_song(self):
        self.api.get_watch_playlist.return_value["tracks"] = [{"videoId": "SVkGRoLicuA"}]
        self.assertEqual(helper.fetch_timed_lyrics(VIDEO, self.api), {
            "videoId": VIDEO, "lines": [], "reason": "video_mismatch",
        })
        self.api.get_lyrics.assert_not_called()

    def test_rejects_invalid_id_before_any_request(self):
        for value in ("", "short", VIDEO + "/x", "https://youtube.com/watch?v=" + VIDEO, None):
            with self.subTest(value=value):
                self.assertEqual(helper.fetch_timed_lyrics(value, self.api), {"videoId": "", "lines": []})
        self.api.get_watch_playlist.assert_not_called()

    def test_skips_missing_or_untrusted_lyrics_reference(self):
        for value, reason in (
            (None, "lyrics_ref_missing"),
            ("", "lyrics_ref_missing"),
            ("https://attacker.example/lyrics", "lyrics_ref_invalid"),
            ("MPLY" + "x" * 501, "lyrics_ref_invalid"),
            ({"private": "secret"}, "lyrics_ref_invalid"),
        ):
            with self.subTest(value=value):
                self.api.get_watch_playlist.return_value["lyrics"] = value
                self.assertEqual(helper.fetch_timed_lyrics(VIDEO, self.api), {
                    "videoId": VIDEO, "lines": [], "reason": reason,
                })
        self.api.get_lyrics.assert_not_called()

    def test_skips_missing_tracks_and_plain_lyrics(self):
        for watch in (None, {}, {"tracks": []}, {"tracks": [None]}, {"tracks": "wrong"}):
            with self.subTest(watch=watch):
                self.api.get_watch_playlist.return_value = watch
                self.assertEqual(helper.fetch_timed_lyrics(VIDEO, self.api), {
                    "videoId": VIDEO, "lines": [], "reason": "watch_invalid",
                })
        self.api.get_watch_playlist.return_value = {"tracks": [{"videoId": VIDEO}], "lyrics": REF}
        for result, reason in (
            (None, "no_lyrics"),
            ({"hasTimestamps": True, "lyrics": []}, "no_lyrics"),
            ({"hasTimestamps": False, "lyrics": "original fixture text"}, "untimed"),
            ({"lyrics": []}, "invalid_lines"),
            ("private upstream payload", "invalid_lines"),
            (timed([{"start_time": -1, "text": "private text"}]), "invalid_lines"),
        ):
            with self.subTest(reason=reason):
                self.api.get_lyrics.return_value = result
                self.assertEqual(helper.fetch_timed_lyrics(VIDEO, self.api), {
                    "videoId": VIDEO, "lines": [], "reason": reason,
                })

    def test_rejects_invalid_timing_instead_of_synthesizing_it(self):
        for value in (None, True, "1200", -1, 1.25, float("inf"), float("nan"), helper.MAX_TIME_MS + 1):
            with self.subTest(value=value):
                self.assertEqual(helper.validated_lines(timed([{"start_time": value, "text": "fixture"}])), [])
        self.assertEqual(helper.validated_lines(timed([
            {"start_time": 2500, "text": "fixture"},
            {"start_time": 1200, "text": "fixture"},
        ])), [])

    def test_bounds_text_and_line_count_and_rejects_non_utf8(self):
        for text in (None, 4, "x\0y", "\ud800", "界" * 22000):
            with self.subTest(text_type=type(text).__name__):
                self.assertEqual(helper.validated_lines(timed([{"start_time": 0, "text": text}])), [])
        line = {"start_time": 0, "text": "fixture"}
        self.assertEqual(helper.validated_lines(timed([line] * 4001)), [])
        self.assertEqual(helper.validated_lines(timed([{"start_time": 0, "text": " "}])), [])

    def test_supports_dict_models_and_cleans_embedded_line_breaks(self):
        self.assertEqual(helper.validated_lines(timed([
            {"start_time": 1200.0, "text": "first\r\nsecond"},
        ])), [{"timeMs": 1200, "text": "first second"}])

    def test_runtime_errors_are_operational_failures_with_no_raw_details(self):
        self.api.get_watch_playlist.side_effect = TimeoutError("private-cookie-secret")
        with self.assertRaisesRegex(helper.LyricsLookupError, "^lookup_failed$"):
            helper.fetch_timed_lyrics(VIDEO, self.api)

    def test_cli_outputs_one_json_object_and_hides_runtime_errors(self):
        for result, failure, expected_code in (
            ({"videoId": VIDEO, "lines": []}, False, 0),
            ({"videoId": VIDEO, "lines": [], "reason": "untimed"}, False, 0),
            (None, True, 1),
        ):
            out, err = io.StringIO(), io.StringIO()
            with patch.object(helper, "fetch_timed_lyrics", side_effect=RuntimeError("private-cookie-secret") if failure else None, return_value=result):
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    code = helper.main([VIDEO])
            self.assertEqual(code, expected_code)
            self.assertEqual(json.loads(out.getvalue()),
                             {"videoId": VIDEO, "lines": []} if failure else result)
            self.assertEqual(len(out.getvalue().splitlines()), 1)
            self.assertEqual(err.getvalue(), "")
            self.assertNotIn("private", out.getvalue())


class CookieTests(unittest.TestCase):
    def test_reuses_only_unexpired_youtube_cookies_without_printing_them(self):
        module = types.ModuleType('ytmusicapi.helpers')
        module.initialize_headers = lambda: {'origin': 'https://music.youtube.com'}
        module.get_authorization = lambda value: 'SAPISIDHASH 123_' + 'a' * 40
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'cookies'
            filename.write_text('# Netscape HTTP Cookie File\n'
                '.youtube.com\tTRUE\t/\tTRUE\t2147483647\t__Secure-3PAPISID\tfixture-session\n'
                '.attacker.example\tTRUE\t/\tTRUE\t2147483647\tprivate\toutside-fixture\n'
                '.youtube.com\tTRUE\t/\tTRUE\t1\texpired\texpired-fixture\n')
            with patch.dict(sys.modules, {'ytmusicapi.helpers': module}):
                result = helper.browser_auth_from_cookie_file(str(filename))
            self.assertEqual(result['cookie'], '__Secure-3PAPISID=fixture-session')
            self.assertEqual(result['x-goog-authuser'], '0')
            filename.write_text('# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tCONSENT\tYES\n')
            self.assertIsNone(helper.browser_auth_from_cookie_file(str(filename)))
        self.assertIsNone(helper.browser_auth_from_cookie_file('/nonexistent-fixture'))


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.responses = []
        owner = self

        class Session:
            def request(self, method, url, **kwargs):
                owner.calls.append((method, url, kwargs))
                return owner.responses.pop(0)

        module = types.ModuleType("requests")
        module.Session = Session
        self.modules = patch.dict(sys.modules, {"requests": module})
        self.modules.start()
        self.addCleanup(self.modules.stop)
        self.session = helper.create_bounded_session()

    def response(self, status=200, headers=None, chunks=None):
        response = MagicMock(status_code=status, headers=headers or {})
        response.iter_content.return_value = iter(chunks or [b"fixture"])
        self.responses.append(response)
        return response

    def test_anonymous_bounded_streaming_request(self):
        response = self.response(chunks=[b"first", b"second"])
        self.assertIs(self.session.request("POST", "https://music.youtube.com/youtubei/v1/browse"), response)
        self.assertFalse(self.session.trust_env)
        self.assertIsNone(self.session.auth)
        self.assertEqual(response._content, b"firstsecond")
        self.assertTrue(response._content_consumed)
        self.assertEqual(self.calls[0][2], {"timeout": (2, 3), "allow_redirects": False, "stream": True})
        response.close.assert_called_once()

    def test_rejects_external_urls_auth_and_unneeded_endpoints(self):
        for url in (
            "http://music.youtube.com/",
            "https://music.youtube.com.attacker.example/",
            "https://user:secret@music.youtube.com/",
            "https://music.youtube.com:8443/",
            "https://music.youtube.com/youtubei/v1/search",
            "file:///private",
        ):
            with self.subTest(url=url), self.assertRaises(ValueError):
                self.session.request("GET", url)
        for kwargs in ({"headers": {"Authorization": "private"}}, {"auth": ("private", "secret")}):
            with self.assertRaises(ValueError):
                self.session.request("GET", "https://music.youtube.com/", **kwargs)
        self.assertEqual(self.calls, [])

    def test_rejects_redirects_and_declared_or_streamed_oversize(self):
        for status, headers, chunks in (
            (302, {"Location": "https://attacker.example/"}, [b"unused"]),
            (200, {"Content-Length": str(helper.MAX_RESPONSE_BYTES + 1)}, [b"unused"]),
            (200, {}, [b"x" * helper.MAX_RESPONSE_BYTES, b"x"]),
        ):
            with self.subTest(status=status, headers=headers):
                session = helper.create_bounded_session()
                response = self.response(status, headers, chunks)
                with self.assertRaises(ValueError):
                    session.request("GET", "https://music.youtube.com/")
                response.close.assert_called_once()

    def test_caps_total_http_calls(self):
        for _ in range(helper.MAX_HTTP_REQUESTS):
            self.response()
            self.session.request("GET", "https://music.youtube.com/")
        with self.assertRaisesRegex(ValueError, "request_limit"):
            self.session.request("GET", "https://music.youtube.com/")
        self.assertEqual(len(self.calls), helper.MAX_HTTP_REQUESTS)

    def test_explicit_browser_session_allows_only_generated_youtube_auth(self):
        session = helper.create_bounded_session(browser_auth=True)
        self.response()
        session.request('POST', 'https://music.youtube.com/youtubei/v1/browse',
                        headers={'Authorization': 'SAPISIDHASH 123_' + 'a' * 40})
        with self.assertRaises(ValueError):
            session.request('POST', 'https://music.youtube.com/youtubei/v1/browse',
                            headers={'Authorization': 'Bearer fixture'})
        with self.assertRaises(ValueError):
            session.request('POST', 'https://attacker.example/youtubei/v1/browse',
                            headers={'Authorization': 'SAPISIDHASH 123_' + 'a' * 40})


if __name__ == "__main__":
    unittest.main()
