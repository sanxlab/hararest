"""Offline regression tests for avscan_scraper."""

import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import MagicMock

sys.dont_write_bytecode = True
sys.modules["cloudscraper"] = types.ModuleType("cloudscraper")
ROOT = Path(__file__).resolve().parents[2]


def load_scraper(module_name: str, relative_path: str):
    spec = importlib.util.spec_from_file_location(module_name, ROOT / relative_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


avscan = load_scraper("avscan_scraper", "src/modules/avscan/avscan_scraper.py")


class AvscanScraperTests(unittest.TestCase):
    def test_frame_stem(self):
        self.assertEqual(avscan.frame_stem("path/to/FWAY-031_00-00-38.jpg"), "FWAY-031_00-00-38")
        self.assertEqual(avscan.frame_stem(r"C:\images\COVER_cover_full.png"), "COVER_cover_full")

    def test_parse_timestamp(self):
        self.assertEqual(avscan.parse_timestamp("IPX-917_02-23-35.jpg"), "02:23:35")
        self.assertEqual(avscan.parse_timestamp("MIDE-123_cover_full.jpg"), "Cover")
        self.assertEqual(avscan.parse_timestamp("MIDE-123_cover_left.jpg"), "Cover")
        self.assertEqual(avscan.parse_timestamp("no_delimiter"), "--:--:--")
        self.assertEqual(avscan.parse_timestamp(""), "--:--:--")

    def test_build_thumb_url(self):
        self.assertEqual(
            avscan.build_thumb_url("FWAY-031", "FWAY-031_00-00-38.jpg", "/thumb/test/path.webp"),
            "https://avscan.cc/thumb/test/path.webp",
        )
        self.assertEqual(
            avscan.build_thumb_url("FWAY-031", "FWAY-031_00-00-38.jpg", "https://cdn.example.com/thumb.webp"),
            "https://cdn.example.com/thumb.webp",
        )
        self.assertEqual(
            avscan.build_thumb_url("MIDE-123", "MIDE-123_cover_full.jpg"),
            "https://avscan.cc/thumb/covers/MIDE-123.webp",
        )
        self.assertEqual(
            avscan.build_thumb_url("IPX-917", "IPX-917_01-15-00.jpg"),
            "https://avscan.cc/thumb/IPX-917/IPX-917_01-15-00.webp",
        )

    def test_search_avscan_parses_results(self):
        mock_scraper = MagicMock()
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "results": [
                {
                    "video_code": "FWAY-031",
                    "best_similarity": 85.5,
                    "frames": [
                        {
                            "image_name": "FWAY-031_00-00-38.jpg",
                            "similarity": 85.5,
                            "thumb": "/thumb/FWAY-031/frame.webp",
                        }
                    ],
                }
            ]
        }
        mock_scraper.post.return_value = mock_response

        # Pass dummy 60 bytes of valid jpeg-like header
        dummy_bytes = b"\xff\xd8\xff\xe0" + b"\x00" * 60
        with unittest.mock.patch.object(avscan, "read_image_bytes", return_value=dummy_bytes):
            res = avscan.search_avscan("dummy_path", scraper=mock_scraper)

        self.assertEqual(res["count"], 1)
        item = res["results"][0]
        self.assertEqual(item["video_code"], "FWAY-031")
        self.assertEqual(item["best_similarity"], 85.5)
        self.assertEqual(item["best_timestamp"], "00:00:38")
        self.assertEqual(item["best_thumb"], "https://avscan.cc/thumb/FWAY-031/frame.webp")
        self.assertEqual(item["watch_urls"]["missav"], "https://missav.ai/en/fway-031")
        self.assertEqual(item["watch_urls"]["javdb"], "https://javdb.com/search?q=FWAY-031&f=all")

    def test_search_avscan_handles_rate_limit(self):
        mock_scraper = MagicMock()
        mock_response = MagicMock()
        mock_response.status_code = 429
        mock_scraper.post.return_value = mock_response

        dummy_bytes = b"\xff\xd8\xff\xe0" + b"\x00" * 60
        with unittest.mock.patch.object(avscan, "read_image_bytes", return_value=dummy_bytes):
            with self.assertRaisesRegex(avscan.AvscanError, "rate limit"):
                avscan.search_avscan("dummy_path", scraper=mock_scraper)


if __name__ == "__main__":
    unittest.main()
