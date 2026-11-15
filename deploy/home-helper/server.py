"""Private Hararest home helper: lyrics and YouTube cookies on one tailnet URL.

Endpoints (all require ``Authorization: Bearer <HOME_HELPER_TOKEN>``):
  GET /health            -> {"ok": true, "cookies": bool}
  GET /lyrics/<videoId>  -> timed YouTube Music lyrics (JSON)
  GET /cookies           -> Netscape cookie file for yt-dlp (text/plain)
  PUT /cookies           -> save yt-dlp rotated cookies (requires matching If-Match ETag)

Bind exclusively to the tailnet address. Never log credentials or content.
"""
import hashlib
import hmac
import json
import os
import re
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TOKEN = os.environ['HOME_HELPER_TOKEN']
BIND = os.environ['HOME_HELPER_BIND']
COOKIE_PATH = Path(os.environ.get('HOME_HELPER_COOKIE_PATH') or ROOT / 'cookies.txt')
MAX_COOKIE_BYTES = 48 * 1024
if len(TOKEN) < 32:
    raise SystemExit('helper token too short')


def is_netscape_cookies(data):
    """Return True only when data is a complete Netscape cookie export."""
    if not data or len(data) > MAX_COOKIE_BYTES or b'\0' in data:
        return False
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        return False
    if not re.match(r'# (?:Netscape )?HTTP Cookie File(?:\r?\n|$)', text):
        return False
    rows = [line for line in re.split(r'\r?\n', text)
            if line.strip() and (not line.startswith('#') or line.startswith('#HttpOnly_'))]
    return bool(rows) and all(len(line.split('\t')) == 7 for line in rows)


def has_youtube_login(data):
    """Return True when the jar holds an unexpired YouTube login cookie."""
    now = time.time()
    for line in re.split(r'\r?\n', data.decode('utf-8')):
        if line.startswith('#') and not line.startswith('#HttpOnly_'):
            continue
        fields = line.removeprefix('#HttpOnly_').split('\t')
        if len(fields) != 7:
            continue
        domain, _, _, _, expires, name, value = fields
        try:
            expiry = int(expires)
        except ValueError:
            continue
        if re.search(r'(?:^|\.)youtube\.com$', domain) and name == '__Secure-3PAPISID' and value and (expiry == 0 or expiry > now):
            return True
    return False


def read_cookies():
    """Return the cookie file bytes only when it is a complete Netscape export."""
    try:
        data = COOKIE_PATH.read_bytes()
    except OSError:
        return None
    return data if is_netscape_cookies(data) else None


def write_cookies_atomic(data):
    tmp = COOKIE_PATH.with_name(f'.{COOKIE_PATH.name}.{os.getpid()}.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        with os.fdopen(fd, 'wb') as handle:
            handle.write(data)
        os.chmod(tmp, 0o600)
        os.replace(tmp, COOKIE_PATH)
    except BaseException:
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
        raise


def etag_for(data):
    return f'"{hashlib.sha256(data).hexdigest()}"'


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(3)

    def log_message(self, *args):
        pass  # Never log credentials, paths, cookies or lyric content.

    def authorized(self):
        return hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN)

    def send(self, status, body, content_type, etag=None):
        self.send_response(status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if etag is not None:
            self.send_header('ETag', etag)
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)

    def reply(self, status, value, etag=None):
        self.send(status, json.dumps(value, ensure_ascii=False).encode(), 'application/json; charset=utf-8', etag=etag)

    def do_GET(self):
        if not self.authorized():
            return self.reply(401, {'error': 'unauthorized'})
        if self.path == '/health':
            return self.reply(200, {'ok': True, 'cookies': read_cookies() is not None})
        if self.path == '/cookies':
            data = read_cookies()
            if data is None:
                return self.reply(404, {'error': 'cookies_unavailable'})
            return self.send(200, data, 'text/plain; charset=utf-8', etag=etag_for(data))
        match = re.fullmatch(r'/lyrics/([A-Za-z0-9_-]{11})', self.path)
        if not match:
            return self.reply(404, {'error': 'not_found'})
        try:
            env = {**os.environ, 'HARAREST_YTMUSIC_COOKIE_PATH': str(COOKIE_PATH)}
            result = subprocess.run([sys.executable, str(ROOT / 'ytmusic_lyrics.py'), match[1]], env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True)
            if len(result.stdout) > 256 * 1024:
                raise ValueError()
            value = json.loads(result.stdout)
        except (subprocess.SubprocessError, ValueError):
            return self.reply(502, {'error': 'lookup_failed'})
        return self.reply(200, value)

    def do_PUT(self):
        if not self.authorized():
            return self.reply(401, {'error': 'unauthorized'})
        if self.path != '/cookies':
            return self.reply(404, {'error': 'not_found'})
        try:
            length = int(self.headers.get('Content-Length', ''))
        except ValueError:
            return self.reply(411, {'error': 'length_required'})
        if length <= 0 or length > MAX_COOKIE_BYTES:
            return self.reply(413 if length > MAX_COOKIE_BYTES else 400, {'error': 'invalid_length'})
        data = self.rfile.read(length)
        if len(data) != length or not is_netscape_cookies(data) or not has_youtube_login(data):
            return self.reply(400, {'error': 'invalid_cookies'})
        current = read_cookies()
        if_match = self.headers.get('If-Match', '').strip()
        if current is None or not if_match or not hmac.compare_digest(if_match, etag_for(current)):
            return self.reply(412, {'error': 'precondition_failed'})
        try:
            write_cookies_atomic(data)
        except OSError:
            return self.reply(500, {'error': 'write_failed'})
        return self.reply(200, {'ok': True}, etag=etag_for(data))


class Server(HTTPServer):
    request_queue_size = 4


Server((BIND, 20129), Handler).serve_forever()
