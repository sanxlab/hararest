"""Offline regression tests for Python scraper trust boundaries."""

import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import MagicMock, patch


# These tests exercise URL handling without requiring network or cloudscraper.
sys.dont_write_bytecode = True
sys.modules["cloudscraper"] = types.ModuleType("cloudscraper")
ROOT = Path(__file__).resolve().parents[2]


def load_scraper(module_name, relative_path):
    spec = importlib.util.spec_from_file_location(module_name, ROOT / relative_path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


instagram = load_scraper("snapinsta_scraper", "src/modules/instagram/snapinsta_scraper.py")
facebook = load_scraper("snapsave_scraper", "src/modules/facebook/snapsave_scraper.py")


class ScraperSecurityTests(unittest.TestCase):
    def test_instagram_accepts_same_origin_relative_and_absolute_endpoints(self):
        for endpoint in ("/api/ajaxSearch", "https://snapinsta.to/api/ajaxSearch"):
            config = instagram.parse_page_config(f"k_url_search = '{endpoint}'")
            self.assertEqual(config.search_url, "https://snapinsta.to/api/ajaxSearch")

    def test_instagram_rejects_untrusted_search_endpoints(self):
        for endpoint in (
            "http://127.0.0.1/admin",
            "https://attacker.example/search",
            "//169.254.169.254/latest/meta-data",
            "https://snapinsta.to.attacker.example/search",
            "https://user:pass@snapinsta.to/api/search",
            "https://snapinsta.to:8443/api/search",
        ):
            with self.subTest(endpoint=endpoint):
                with self.assertRaises(instagram.SnapInstaError):
                    instagram.parse_page_config(f"k_url_search = '{endpoint}'")

    def test_scrapers_reject_redirects_before_sending_any_post(self):
        for module, operation, expected_error in (
            (instagram, instagram.fetch_snapinsta_data, instagram.SnapInstaError),
            (facebook, facebook.fetch_snapsave_data, facebook.SnapSaveError),
        ):
            with self.subTest(scraper=module.__name__):
                scraper = MagicMock()
                scraper.get.return_value.is_redirect = True
                with patch.object(module.cloudscraper, "create_scraper", return_value=scraper, create=True):
                    with self.assertRaises(expected_error):
                        operation("https://example.com/post")
                self.assertFalse(scraper.get.call_args.kwargs["allow_redirects"])
                scraper.post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
