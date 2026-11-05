"""Temporary operator diagnostic; never print credentials or raw app logs."""
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import urllib.parse
import urllib.request

app = os.environ['HEROKU_APP_NAME']
key = os.environ['HEROKU_API_KEY']
if not app or not key:
    raise SystemExit('Missing diagnostic configuration')

# Read only known lyrics events, emitting a fixed subset of safe fields.
request = urllib.request.Request(
    'https://api.heroku.com/apps/' + urllib.parse.quote(app, safe='') + '/log-sessions',
    data=json.dumps({'dyno':'web.1','source':'app','lines':200,'tail':False}).encode(),
    headers={'Authorization':'Bearer '+key,'Accept':'application/vnd.heroku+json; version=3','Content-Type':'application/json'},
)
try:
    with urllib.request.urlopen(request, timeout=20) as response:
        url = json.load(response)['logplex_url']
    with urllib.request.urlopen(url, timeout=20) as response:
        logs = response.read(2*1024*1024).decode('utf-8', errors='replace')
    reasons = {'invalid_input','cache_hit','queue_full','invalid_response','empty','found','cancelled','request_failed','watch_invalid','video_mismatch','lyrics_ref_missing','lyrics_ref_invalid','no_lyrics','untimed','invalid_lines','cache_miss','retry','instrumental','not_found','lookup_failed'}
    events = {'YouTube Music timed lyrics':'timed','YouTube Music lyrics embedded':'embedded','YouTube Music lyrics lookup':'lookup'}
    for line in logs.splitlines():
        try:
            event = json.loads(line[line.index('{'):])
        except (ValueError, json.JSONDecodeError):
            continue
        if event.get('message') not in events:
            continue
        safe = {'diagnostic':'web_log','event':events[event['message']]}
        for name in ('reason','detail'):
            if isinstance(event.get(name), str) and event[name] in reasons:
                safe[name] = event[name]
        if isinstance(event.get('synchronized'), bool):
            safe['synchronized'] = event['synchronized']
        if event.get('source') in ('lrclib','youtube_music'):
            safe['source'] = event['source']
        if isinstance(event.get('timestamp'), str) and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z', event['timestamp']):
            safe['timestamp'] = event['timestamp']
        print(json.dumps(safe), flush=True)
except Exception:
    print(json.dumps({'diagnostic':'web_log','error':'log_read_failed'}), flush=True)

source = Path('scripts/youtube-lyrics-diagnostic.py').read_text()
command = '/opt/media-fallback/bin/python -c ' + shlex.quote(source)
try:
    result = subprocess.run(
        ['heroku','run','--no-tty','--no-notify','--exit-code','--app',app,'--',command],
        capture_output=True, text=True, timeout=150,
    )
except subprocess.TimeoutExpired:
    raise SystemExit('Remote diagnostic timed out') from None
found = False
for line in result.stdout.splitlines():
    try:
        row = json.loads(line)
    except json.JSONDecodeError:
        continue
    if isinstance(row, dict) and row.get('probe') in ('default','minimal'):
        print(json.dumps(row), flush=True)
        found = True
if result.returncode or not found:
    print(json.dumps({'diagnostic':'remote','error':'remote_diagnostic_failed','exitCode':result.returncode}), flush=True)
    raise SystemExit(1)
