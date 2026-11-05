"""Private, serial lyrics endpoint. Bind exclusively to the tailnet address."""
import hmac
import json
import os
import re
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TOKEN = os.environ['LYRICS_HELPER_TOKEN']
if len(TOKEN) < 32:
    raise SystemExit('helper token too short')

class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(3)

    def log_message(self, *args):
        pass  # Never log credentials, paths or lyric content.

    def reply(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Connection', 'close')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if not hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer ' + TOKEN):
            return self.reply(401, {'error': 'unauthorized'})
        match = re.fullmatch(r'/lyrics/([A-Za-z0-9_-]{11})', self.path)
        if not match:
            return self.reply(404, {'error': 'not_found'})
        try:
            result = subprocess.run([sys.executable, str(ROOT / 'ytmusic_lyrics.py'), match[1]],
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=15, check=True)
            if len(result.stdout) > 256 * 1024:
                raise ValueError()
            value = json.loads(result.stdout)
        except (subprocess.SubprocessError, ValueError):
            return self.reply(502, {'error': 'lookup_failed'})
        return self.reply(200, value)

class Server(HTTPServer):
    request_queue_size = 4

Server((os.environ['LYRICS_HELPER_BIND'], 20129), Handler).serve_forever()
