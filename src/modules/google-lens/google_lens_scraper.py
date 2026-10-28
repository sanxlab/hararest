#!/usr/bin/env python3
"""Upload a sanitized image to Google Lens and return bounded visual matches."""

import argparse
import json
import os
import random
import re
import sys
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright
from playwright_stealth import Stealth

ALLOWED_HOSTS = (
    "google.com",
    "google.co.id",
    "googleusercontent.com",
    "gstatic.com",
    "googleapis.com",
)
MAX_RESULTS = 30
MAX_IMAGES = 50
MAX_LINKS = 50
MAX_TEXT = 12000
MAX_REDIRECT_LOOKUPS = 20


def human_delay(low: float, high: float) -> None:
    import time

    time.sleep(random.uniform(low, high))


def allowed_google_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()
        return parsed.scheme in ("http", "https") and any(
            host == suffix or host.endswith("." + suffix) for suffix in ALLOWED_HOSTS
        )
    except (TypeError, ValueError):
        return False


def external_http_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()
        return parsed.scheme in ("http", "https") and host and not any(
            host == suffix or host.endswith("." + suffix) for suffix in ALLOWED_HOSTS
        )
    except (TypeError, ValueError):
        return False


def clean_ai_response(value: str) -> str:
    """Drop Google's page chrome and retain the AI conversation from the user prompt onward."""
    match = re.search(r"(?:Anda mengirim|You sent)\s*:", value, re.IGNORECASE)
    return value[match.start():].strip() if match else ""


def scrape(image: Path, mode: str = "visual") -> dict:
    with sync_playwright() as playwright:
        profile_dir = Path(
            os.environ.get(
                "GOOGLE_LENS_PROFILE_DIR",
                str(Path(__file__).resolve().parents[3] / ".browser_profile"),
            )
        )
        profile_dir.mkdir(parents=True, exist_ok=True)
        context = playwright.chromium.launch_persistent_context(
            user_data_dir=str(profile_dir),
            headless=True,
            executable_path=os.environ.get("GOOGLE_LENS_CHROMIUM", "/usr/bin/chromium"),
            args=[
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-blink-features=AutomationControlled",
                "--no-first-run",
                "--no-default-browser-check",
                "--disable-infobars",
                "--disable-popup-blocking",
            ],
            ignore_default_args=["--enable-automation"],
            locale="id-ID",
            timezone_id="Asia/Jakarta",
            viewport={"width": 1366, "height": 768},
            user_agent=(
                "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
            ),
        )
        page = context.pages[0] if context.pages else context.new_page()
        stealth = Stealth(
            navigator_languages_override=("id-ID", "id"),
            navigator_platform_override="Linux x86_64",
        )
        stealth.apply_stealth_sync(page)
        page.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            Object.defineProperty(navigator, 'plugins', {get: () => [1,2,3,4,5]});
            Object.defineProperty(navigator, 'languages', {get: () => ['id-ID','id','en-US','en']});
            window.chrome = { runtime: {} };
        """)
        page.set_default_timeout(15000)
        page.set_default_navigation_timeout(25000)

        # The result page may contain arbitrary remote URLs. Keep the browser
        # confined to Google's public properties so hostile results cannot make
        # requests to internal services or local network addresses.
        page.route("**/*", lambda route: route.continue_() if allowed_google_url(route.request.url) else route.abort())
        try:
            try:
                context.add_cookies(
                    [
                        {"name": "PREF", "value": "f2=4000000", "domain": ".google.com", "path": "/"},
                        {"name": "PREFS", "value": "SB=0", "domain": ".google.com", "path": "/"},
                    ]
                )
            except Exception:
                pass
            human_delay(0.5, 1.5)
            page.goto("https://lens.google.com/", wait_until="domcontentloaded")
            human_delay(1, 3)
            try:
                consent = page.locator(
                    'button:has-text("Terima"), button:has-text("Accept"), button:has-text("I agree")'
                )
                if consent.count():
                    consent.first.click(timeout=2000)
                    human_delay(1, 2)
            except Exception:
                pass
            upload = page.locator('input[type="file"]').first
            upload.wait_for(state="attached")
            human_delay(0.5, 1.5)
            upload.set_input_files(str(image))

            try:
                page.get_by_text("Gambar ditambahkan", exact=True).wait_for(timeout=10000)
            except PlaywrightTimeoutError:
                pass
            human_delay(0.5, 1.2)

            try:
                query = page.locator('textarea[name="q"], input[name="q"]').first
                query.wait_for(state="visible", timeout=10000)
                human_delay(0.3, 0.8)
                query.press("Enter")
            except PlaywrightTimeoutError:
                submit = page.get_by_role("button", name="Telusuri", exact=True)
                if submit.count():
                    human_delay(0.3, 0.8)
                    submit.first.click()

            try:
                page.wait_for_url(lambda url: "olud=" not in str(url), timeout=20000)
            except PlaywrightTimeoutError:
                pass
            page.wait_for_timeout(5000 + random.randint(0, 3000))

            if "/search?" in page.url and "safe=off" not in page.url:
                try:
                    page.goto(f"{page.url}&safe=off", wait_until="domcontentloaded", timeout=15000)
                    page.wait_for_timeout(3000)
                except Exception:
                    pass

            if "/sorry/" in page.url or "recaptcha" in page.url.lower():
                raise RuntimeError("Google Lens meminta verifikasi tambahan; coba lagi nanti.")
            if "google.com/webhp" in page.url and "olud=" not in page.url:
                raise RuntimeError("Google Lens kembali ke beranda sebelum menampilkan hasil.")

            labels = (
                ("Mode AI", "AI Mode", "AI Overview")
                if mode == "ai"
                else ("Kecocokan visual", "Pencocokan visual", "Visual matches", "Exact matches", "Kecocokan persis")
            )
            clicked_tab = False
            for label in labels:
                try:
                    tab = page.locator(
                        f'a:has-text("{label}"), button:has-text("{label}"), '
                        f'[role="tab"]:has-text("{label}")'
                    ).first
                    if tab.count():
                        human_delay(0.5, 1)
                        tab.click(timeout=2000)
                        clicked_tab = True
                        break
                except Exception:
                    continue

            if mode == "visual" and not clicked_tab:
                try:
                    visual_mode = page.locator('a[href*="udm=2"], a[href*="udm=14"]').first
                    if visual_mode.count():
                        human_delay(0.5, 1)
                        visual_mode.click(timeout=2000)
                except Exception:
                    pass

            page.wait_for_timeout(5000 + random.randint(0, 3000))
            if mode == "ai":
                for _ in range(2):
                    page.evaluate("window.scrollBy(0, 400)")
                    page.wait_for_timeout(1000 + random.randint(0, 500))
            else:
                for _ in range(4):
                    page.evaluate("window.scrollBy(0, window.innerHeight)")
                    page.wait_for_timeout(1500 + random.randint(0, 1000))

            extracted = page.evaluate(
                """({ maxResults, maxImages, maxLinks }) => {
                  const cleanText = value => (value || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
                  const safeLink = value => {
                    try {
                      let url = new URL(value, location.href);
                      if (!['http:', 'https:'].includes(url.protocol)) return '';
                      if (/(^|\\.)google\\./i.test(url.hostname)) {
                        const redirected = ['url', 'q', 'imgrefurl'].map(key => url.searchParams.get(key)).find(candidate => {
                          if (!candidate) return false;
                          try { return !/(^|\\.)google\\./i.test(new URL(candidate).hostname); }
                          catch { return false; }
                        });
                        if (!redirected) return '';
                        url = new URL(redirected);
                      }
                      return url.href;
                    } catch { return ''; }
                  };
                  const matches = [];
                  const seenMatches = new Set();
                  const cards = document.querySelectorAll(
                    'div[data-action-url], div[data-item-id], g-section-with-header, div.isv-r, div[jsname]'
                  );
                  for (const card of cards) {
                    const anchor = card.querySelector('a[href]');
                    const image = card.querySelector('img[src]');
                    if (!anchor || !image) continue;
                    const url = safeLink(anchor.href);
                    if (!url || seenMatches.has(url)) continue;
                    seenMatches.add(url);
                    matches.push({
                      title: cleanText(anchor.innerText || anchor.getAttribute('aria-label') || card.innerText),
                      url,
                      thumbnail: /^https?:/.test(image.src) ? image.src : ''
                    });
                    if (matches.length >= maxResults) break;
                  }
                  if (matches.length === 0) {
                    for (const anchor of document.querySelectorAll('a[href]')) {
                      const url = safeLink(anchor.href);
                      if (!url || seenMatches.has(url)) continue;
                      const image = anchor.querySelector('img[src]') || anchor.parentElement?.querySelector('img[src]');
                      const title = cleanText(anchor.innerText || anchor.getAttribute('aria-label') || image?.alt);
                      const thumbnail = image?.currentSrc || image?.src || '';
                      if (!title && !thumbnail) continue;
                      seenMatches.add(url);
                      matches.push({ title, url, thumbnail: /^https?:/.test(thumbnail) ? thumbnail : '' });
                      if (matches.length >= maxResults) break;
                    }
                  }
                  const images = [];
                  const seenImages = new Set();
                  for (const image of document.querySelectorAll('img[src]')) {
                    const src = image.currentSrc || image.src || '';
                    if (!/^https?:/.test(src) || /\\.(google|gstatic)\\.com\\/images/i.test(src)) continue;
                    if (image.naturalWidth < 50 && image.width < 50) continue;
                    if (seenImages.has(src)) continue;
                    seenImages.add(src);
                    const anchor = image.closest('a[href]');
                    images.push({
                      src,
                      width: Math.min(image.naturalWidth || image.width || 0, 10000),
                      height: Math.min(image.naturalHeight || image.height || 0, 10000),
                      alt: cleanText(image.alt),
                      pageUrl: anchor ? safeLink(anchor.href) : ''
                    });
                    if (images.length >= maxImages) break;
                  }
                  const links = [];
                  const seenLinks = new Set();
                  const redirects = [];
                  const seenRedirects = new Set();
                  for (const anchor of document.querySelectorAll('a[href]')) {
                    const anchorUrl = new URL(anchor.href, location.href);
                    if ((anchorUrl.hostname === 'google.com' || anchorUrl.hostname.endsWith('.google.com')) && anchorUrl.pathname === '/goto') {
                      if (!seenRedirects.has(anchorUrl.href)) {
                        seenRedirects.add(anchorUrl.href);
                        const image = anchor.querySelector('img[src]') || anchor.parentElement?.querySelector('img[src]');
                        redirects.push({
                          href: anchorUrl.href,
                          title: cleanText(anchor.innerText || anchor.getAttribute('aria-label') || image?.alt),
                          thumbnail: /^https?:/.test(image?.currentSrc || image?.src || '')
                            ? (image.currentSrc || image.src)
                            : ''
                        });
                        if (redirects.length >= maxResults) break;
                      }
                      continue;
                    }
                    const url = safeLink(anchor.href);
                    if (!url || seenLinks.has(url)) continue;
                    seenLinks.add(url);
                    links.push({ title: cleanText(anchor.innerText || anchor.getAttribute('aria-label')), url });
                    if (links.length >= maxLinks) break;
                  }
                  return { matches, images, links, redirects, text: (document.body?.innerText || '').slice(0, 12000) };
                }""",
                {"maxResults": MAX_RESULTS, "maxImages": MAX_IMAGES, "maxLinks": MAX_LINKS},
            )
            ai_extracted = page.evaluate(
                """({ maxResults, maxImages }) => {
                  const externalUrl = value => {
                    try {
                      const url = new URL(value, location.href);
                      if (!['http:', 'https:'].includes(url.protocol)) return '';
                      const googleHost = /(^|\\.)google\\./i.test(url.hostname);
                      if (googleHost) {
                        const target = ['url', 'q', 'imgrefurl'].map(key => url.searchParams.get(key)).find(candidate => {
                          if (!candidate) return false;
                          try { return !/(^|\\.)google\\./i.test(new URL(candidate).hostname); }
                          catch { return false; }
                        });
                        if (!target) return '';
                        return new URL(target).href;
                      }
                      return url.href;
                    } catch { return ''; }
                  };
                  const cleanText = value => (value || '').replace(/\\s+/g, ' ').trim().slice(0, 200);
                  const cards = [];
                  const seenCards = new Set();
                  for (const anchor of document.querySelectorAll('a[href]')) {
                    const sourceUrl = externalUrl(anchor.href);
                    if (!sourceUrl) continue;
                    const container = anchor.closest('div[data-ved], div[role="listitem"], g-inner-card, [jsname]');
                    const image = anchor.querySelector('img') || anchor.parentElement?.querySelector('img') || container?.querySelector('img');
                    if (!image) continue;
                    const imageUrl = image.currentSrc || image.src || image.getAttribute('data-src') || '';
                    if (!/^https?:/.test(imageUrl) || (image.width < 35 && image.height < 35)) continue;
                    const key = `${sourceUrl}|${imageUrl.slice(0, 60)}`;
                    if (seenCards.has(key)) continue;
                    seenCards.add(key);
                    cards.push({
                      title: cleanText(anchor.innerText || anchor.getAttribute('aria-label')),
                      sourceUrl,
                      imageUrl,
                      width: image.naturalWidth || image.width,
                      height: image.naturalHeight || image.height
                    });
                    if (cards.length >= maxResults) break;
                  }
                  const images = [];
                  const seenImages = new Set();
                  for (const image of document.querySelectorAll('img')) {
                    const imageUrl = image.currentSrc || image.src || image.getAttribute('data-src') || '';
                    if (!/^https?:/.test(imageUrl) || /gstatic\\.com\\/images\\/branding|google\\.com\\/images/i.test(imageUrl)) continue;
                    if (image.width < 45 || image.height < 45 || seenImages.has(imageUrl.slice(0, 80))) continue;
                    seenImages.add(imageUrl.slice(0, 80));
                    const anchor = image.closest('a[href]');
                    images.push({
                      imageUrl,
                      width: image.naturalWidth || image.width,
                      height: image.naturalHeight || image.height,
                      alt: cleanText(image.alt),
                      sourceUrl: anchor ? externalUrl(anchor.href) : ''
                    });
                    if (images.length >= maxImages) break;
                  }
                  return { cards, images };
                }""",
                {"maxResults": MAX_RESULTS, "maxImages": MAX_IMAGES},
            ) if mode == "ai" else {"cards": [], "images": []}

            for candidate in extracted["redirects"][:MAX_REDIRECT_LOOKUPS]:
                try:
                    response = context.request.get(
                        candidate["href"], max_redirects=0, timeout=5000
                    )
                    target = response.headers.get("location", "")
                    if not external_http_url(target):
                        continue
                    extracted["matches"].append(
                        {
                            "title": candidate["title"],
                            "url": target,
                            "thumbnail": candidate["thumbnail"],
                        }
                    )
                except Exception:
                    continue

            unique_matches = []
            seen_match_urls = set()
            for match in extracted["matches"]:
                if match["url"] in seen_match_urls:
                    continue
                seen_match_urls.add(match["url"])
                unique_matches.append(match)

            external_links = list(extracted["links"])
            seen_link_urls = {link["url"] for link in external_links}
            for match in unique_matches:
                if match["url"] in seen_link_urls:
                    continue
                seen_link_urls.add(match["url"])
                external_links.append({"title": match["title"], "url": match["url"]})

            return {
                "mode": mode,
                "lensPage": page.url,
                "aiResponse": clean_ai_response(extracted["text"]) if mode == "ai" else "",
                "aiImageCards": ai_extracted["cards"],
                "aiImages": ai_extracted["images"],
                "visualMatches": unique_matches[:MAX_RESULTS],
                "imagesOnPage": extracted["images"],
                "externalLinks": external_links[:MAX_LINKS],
                "pageText": extracted["text"][:MAX_TEXT],
            }
        finally:
            context.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("image", type=Path)
    parser.add_argument("--mode", choices=("ai", "visual"), default="visual")
    args = parser.parse_args()
    try:
        result = scrape(args.image, args.mode)
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
        return 0
    except Exception as error:  # The Node caller maps this bounded message to an API error.
        message = re.sub(r"[\\r\\n\\x00-\\x1f]+", " ", str(error)).strip()[:300]
        sys.stderr.write(message or "Google Lens search failed")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
