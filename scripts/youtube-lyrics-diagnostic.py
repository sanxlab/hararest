"""Temporary runtime cookie check; never emit cookie/header values."""
import http.cookiejar
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import base64
import tempfile
import urllib.request

result = {'probe': 'cookie'}
try:
    encoded = os.environ.pop('HARAREST_TEST_COOKIES_BASE64', '')
    if encoded:
        data = base64.b64decode(encoded, validate=True)
        if len(data) > 65536:
            raise ValueError('cookie_limit')
        fd, filename = tempfile.mkstemp(prefix='lyrics-cookie-test-')
        with os.fdopen(fd, 'wb') as output:
            output.write(data)
    else:
        filename = subprocess.check_output(
            ['node', '-p', "require('./dist/config/default').config.youtube.cookiePath"],
            text=True, timeout=10,
        ).strip().splitlines()[-1]
    result['cookieFilePresent'] = Path(filename).is_file()
    jar = http.cookiejar.MozillaCookieJar(filename)
    jar.load(ignore_discard=True, ignore_expires=True)
    cookies = list(jar)
    result['cookieCount'] = len(cookies)
    result['sessionPresent'] = any(c.name == '__Secure-3PAPISID' for c in cookies)
    result['sessionUnexpired'] = any(c.name == '__Secure-3PAPISID' and not c.is_expired() for c in cookies)
    spec = importlib.util.spec_from_file_location('helper', '/app/src/modules/youtube/ytmusic_lyrics.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    result['authReady'] = bool(helper.browser_auth_from_cookie_file(filename))
    os.environ['HARAREST_YTMUSIC_COOKIE_PATH'] = filename
    data = helper.fetch_timed_lyrics('7IWlXi-hVxk')
    result['timedLines'] = len(data.get('lines', []))
    result['hasTimestamps'] = result['timedLines'] > 0
    result['timedLookup'] = 'found' if result['hasTimestamps'] else 'empty'
    # Public reference from an independent anonymous client, never cookie auth.
    from ytmusicapi import YTMusic
    session = helper.create_bounded_session()
    try:
        anonymous = YTMusic(requests_session=session)
        raw = anonymous._send_request('next', {'videoId': '7IWlXi-hVxk'})
        reference = helper._fallback_lyrics_reference(raw, '7IWlXi-hVxk')
        if reference:
            request = urllib.request.Request(
                'https://b-ytmbrowseproxy.zvz.be/browse?prettyPrint=false',
                data=json.dumps({'browseId': reference, 'context': {'client': {
                    'clientName': '26', 'clientVersion': '7.01.05',
                }}}).encode(), headers={'Content-Type': 'application/json', 'Accept': 'application/json', 'Origin': 'https://music.youtube.com'},
            )
            with urllib.request.urlopen(request, timeout=10) as response:
                result['proxyHTTPStatus'] = response.status
                payload = response.read(4 * 1024 * 1024 + 1)
            if len(payload) <= 4 * 1024 * 1024:
                from ytmusicapi.navigation import nav, TIMESTAMPED_LYRICS
                model = nav(json.loads(payload), TIMESTAMPED_LYRICS, True)
                rows = model.get('timedLyricsData', []) if isinstance(model, dict) else []
                lines = [{'start_time': int(row['cueRange']['startTimeMilliseconds']), 'text': row['lyricLine']} for row in rows]
                result['proxyTimedLines'] = len(helper.validated_lines({'hasTimestamps': True, 'lyrics': lines}))
    finally:
        session.close()
except Exception as error:
    if hasattr(error, 'code') and isinstance(error.code, int):
        result['proxyHTTPStatus'] = error.code
    result['timedLookup'] = 'failed'
print(json.dumps(result), flush=True)
