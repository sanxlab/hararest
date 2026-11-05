"""Offline trust-boundary tests for the optional YouTube Music helper."""

import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import types
import unittest
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


class LookupTests(unittest.TestCase):
    def setUp(self):
        self.api = MagicMock()
        self.api.get_watch_playlist.return_value = {
            "tracks": [{"videoId": VIDEO}], "lyrics": REF,
        }
        self.api.get_lyrics.return_value = timed()

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

    def test_does_not_pick_lyrics_from_a_different_song(self):
        self.api.get_watch_playlist.return_value["tracks"] = [{"videoId": "SVkGRoLicuA"}]
        self.assertEqual(helper.fetch_timed_lyrics(VIDEO, self.api), {"videoId": VIDEO, "lines": []})
        self.api.get_lyrics.assert_not_called()

    def test_rejects_invalid_id_before_any_request(self):
        for value in ("", "short", VIDEO + "/x", "https://youtube.com/watch?v=" + VIDEO, None):
            with self.subTest(value=value):
                self.assertEqual(helper.fetch_timed_lyrics(value, self.api), {"videoId": "", "lines": []})
        self.api.get_watch_playlist.assert_not_called()

    def test_skips_missing_or_untrusted_lyrics_reference(self):
        for value in (None, "", "https://attacker.example/lyrics", "MPLY" + "x" * 501):
            with self.subTest(value=value):
                self.api.get_watch_playlist.return_value["lyrics"] = value
                self.assertEqual(helper.fetch_timed_lyrics(VIDEO, self.api)["lines"], [])
        self.api.get_lyrics.assert_not_called()

    def test_skips_missing_tracks_and_plain_lyrics(self):
        for watch in ({}, {"tracks": []}, {"tracks": [None]}, {"tracks": "wrong"}):
            with self.subTest(watch=watch):
                self.api.get_watch_playlist.return_value = watch
                self.assertEqual(helper.fetch_timed_lyrics(VIDEO, self.api)["lines"], [])
        self.api.get_watch_playlist.return_value = {"tracks": [{"videoId": VIDEO}], "lyrics": REF}
        for result in (None, {"hasTimestamps": False, "lyrics": "original fixture text"}, {"lyrics": []}):
            self.api.get_lyrics.return_value = result
            self.assertEqual(helper.fetch_timed_lyrics(VIDEO, self.api)["lines"], [])

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
            (None, True, 1),
        ):
            out, err = io.StringIO(), io.StringIO()
            with patch.object(helper, "fetch_timed_lyrics", side_effect=RuntimeError("private-cookie-secret") if failure else None, return_value=result):
                with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                    code = helper.main([VIDEO])
            self.assertEqual(code, expected_code)
            self.assertEqual(json.loads(out.getvalue()), {"videoId": VIDEO, "lines": []})
            self.assertEqual(len(out.getvalue().splitlines()), 1)
            self.assertEqual(err.getvalue(), "")
            self.assertNotIn("private", out.getvalue())


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


if __name__ == "__main__":
    unittest.main()
