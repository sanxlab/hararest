from urllib.parse import urlsplit, urlunsplit

from yt_dlp.postprocessor.common import PostProcessor


class YoutubeCoverSourcePP(PostProcessor):
    """Prefer JPEG over its equivalent YouTube WebP, preserving size priorities."""

    def run(self, info):
        if info.get('extractor_key', '').lower() != 'youtube':
            return [], info
        thumbnails = info.get('thumbnails') or []
        by_url = {thumb.get('url'): thumb for thumb in thumbnails}
        for webp in thumbnails:
            url = urlsplit(webp.get('url', ''))
            if not url.path.endswith('.webp') or '/vi_webp/' not in url.path:
                continue
            jpeg_url = urlunsplit(url._replace(
                path=url.path.replace('/vi_webp/', '/vi/')[:-5] + '.jpg'))
            jpeg = by_url.get(jpeg_url)
            if jpeg is None:
                continue
            # Extractor preferences rank resolution variants in steps of two.
            # Only reverse the format tie within the same variant; keep WebP
            # as the next candidate if downloading the JPEG fails.
            jpeg_preference = jpeg.get('preference')
            webp_preference = webp.get('preference')
            if (isinstance(jpeg_preference, (int, float))
                    and isinstance(webp_preference, (int, float))
                    and webp_preference - jpeg_preference == 1):
                jpeg['preference'], webp['preference'] = webp_preference, jpeg_preference
        self._downloader._sort_thumbnails(thumbnails)
        return [], info
