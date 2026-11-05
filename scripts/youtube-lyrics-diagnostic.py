"""Temporary runtime cookie check; never emit cookie/header values."""
import http.cookiejar
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import base64
import tempfile

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
except Exception:
    result['timedLookup'] = 'failed'
print(json.dumps(result), flush=True)
