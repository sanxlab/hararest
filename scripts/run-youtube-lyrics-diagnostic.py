"""Temporary operator diagnostic; never print credentials or raw app logs."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import time
import urllib.error
import urllib.parse
import urllib.request

app = os.environ['HEROKU_APP_NAME']
key = os.environ['HEROKU_API_KEY']
if not app or not key:
    raise SystemExit('Missing diagnostic configuration')

# Read only known lyrics events, emitting a fixed subset of safe fields.
request = urllib.request.Request(
    'https://api.heroku.com/apps/' + urllib.parse.quote(app, safe='') + '/log-sessions',
    data=json.dumps({'dyno_name':'web.1','source':'app','lines':200,'tail':False}).encode(),
    headers={'Authorization':'Bearer '+key,'Accept':'application/vnd.heroku+json; version=3','Content-Type':'application/json'},
)
try:
    with urllib.request.urlopen(request, timeout=20) as response:
        url = json.load(response)['logplex_url']
    with urllib.request.urlopen(url, timeout=20) as response:
        logs = response.read(2*1024*1024).decode('utf-8', errors='replace')
    reasons = {'invalid_input','cache_hit','queue_full','invalid_response','empty','found','cancelled','request_failed','watch_invalid','video_mismatch','lyrics_ref_missing','lyrics_ref_invalid','no_lyrics','untimed','invalid_lines','cache_miss','retry','instrumental','not_found','lookup_failed'}
    events = {'YouTube Music timed lyrics':'timed','YouTube Music lyrics embedded':'embedded','YouTube Music lyrics lookup':'lookup'}
    safe_events = []
    for line in logs.splitlines():
        if re.search(r'\bapp\[web\.1\]:', line) is None:
            continue
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
        safe_events.append(safe)
    for safe in safe_events[-20:]:
        print(json.dumps(safe), flush=True)
except Exception:
    print(json.dumps({'diagnostic':'web_log','error':'log_read_failed'}), flush=True)

API_BASE = 'https://api.heroku.com/apps/' + urllib.parse.quote(app, safe='')
API_HEADERS = {
    'Authorization': 'Bearer ' + key,
    'Accept': 'application/vnd.heroku+json; version=3',
    'Content-Type': 'application/json',
}
PROBES = {'cookie'}


def api_request(route, data=None, method=None, timeout=10):
    request = urllib.request.Request(
        API_BASE + route,
        data=json.dumps(data).encode() if data is not None else None,
        headers=API_HEADERS,
        method=method,
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        body = response.read(1024 * 1024 + 1)
    if len(body) > 1024 * 1024:
        raise ValueError('api_response_limit')
    return json.loads(body) if body else {}


def remote_error(code, error=None):
    safe = {'diagnostic': 'remote', 'error': code}
    if isinstance(error, urllib.error.HTTPError):
        safe['status'] = error.code
        try:
            body = json.loads(error.read(16 * 1024))
            api_id = body.get('id') if isinstance(body, dict) else None
            if isinstance(api_id, str) and re.fullmatch(r'[a-z_]{1,40}', api_id):
                safe['apiId'] = api_id
            message = body.get('message') if isinstance(body, dict) else None
            if error.code == 422 and isinstance(message, str):
                message = message.lower()
                if 'command' in message and ('long' in message or 'length' in message):
                    safe['marker'] = 'command_too_long'
                for field in ('force_no_tty', 'time_to_live', 'command', 'attach', 'size', 'env', 'type'):
                    if re.search(r'(?<![a-z_])' + field + r'(?![a-z_])', message):
                        safe['parameter'] = field
                        break
        except Exception:
            pass
    print(json.dumps(safe), flush=True)


def safe_probe(row):
    if not isinstance(row, dict) or row.get('probe') not in PROBES:
        return None
    safe = {'probe': row['probe']}
    for name in ('timedLines', 'tabCount', 'tabsOmitted', 'selectedPrimaryCount',
                 'selectedPrimaryMatches', 'selectedPrimaryMismatches',
                 'enabledLyricsRefCount', 'lyricsRefCount', 'disabledLyricsRefCount', 'httpRequests',
                 'candidateCount', 'exactCandidateCount', 'durationMs', 'cookieCount', 'proxyTimedLines', 'proxyHTTPStatus', 'cookieMobileTimedLines'):
        if type(row.get(name)) is int and 0 <= row[name] <= 10_000_000:
            safe[name] = row[name]
    for name in ('currentEndpointPresent', 'currentEndpointMatches', 'tabsAreList', 'hasTimestamps', 'cookieFilePresent', 'authReady', 'sessionPresent', 'sessionUnexpired'):
        if type(row.get(name)) is bool:
            safe[name] = row[name]
    if row.get('timedLookup') in ('skipped', 'found', 'empty', 'untimed', 'failed'):
        safe['timedLookup'] = row['timedLookup']
    if row.get('errorCode') in ('unsupported_request', 'request_limit', 'upstream_status', 'response_limit', 'invalid_response'):
        safe['errorCode'] = row['errorCode']
    if row.get('errorType') in (
        'AttributeError', 'ConnectionError', 'ConnectTimeout', 'FileNotFoundError',
        'ImportError', 'JSONDecodeError', 'KeyError', 'LyricsLookupError',
        'ModuleNotFoundError', 'ReadTimeout', 'Timeout', 'TimeoutError', 'TypeError',
        'ValueError', 'YTMusicServerError', 'YTMusicUserError', 'OtherError',
    ):
        safe['errorType'] = row['errorType']
    if isinstance(row.get('tabs'), list):
        safe['tabs'] = []
        for tab in row['tabs'][:8]:
            if not isinstance(tab, dict):
                continue
            shape = {}
            for name in ('rendererValid', 'unselectablePresent', 'unselectableIsTrue',
                         'unselectableIsFalse', 'refPresent', 'refValid'):
                if type(tab.get(name)) is bool:
                    shape[name] = tab[name]
            if tab.get('pageType') in ('lyrics', 'related', 'missing', 'other'):
                shape['pageType'] = tab['pageType']
            safe['tabs'].append(shape)
    return safe


def read_probe_logs(dyno_name):
    log_session = api_request('/log-sessions', {
        'dyno_name': dyno_name, 'source': 'app', 'lines': 100, 'tail': False,
    })
    url = log_session.get('logplex_url')
    if not isinstance(url, str) or urllib.parse.urlsplit(url).scheme != 'https':
        raise ValueError('invalid_log_session')
    # Logplex receives its own signed URL, never the Platform API bearer header.
    with urllib.request.urlopen(url, timeout=10) as response:
        logs = response.read(2 * 1024 * 1024).decode('utf-8', errors='replace')
    origin = re.compile(r'\bapp\[' + re.escape(dyno_name) + r'\]:\s*(\{.*)$')
    rows = []
    for line in logs.splitlines():
        match = origin.search(line)
        if match is None:
            continue
        try:
            row = safe_probe(json.loads(match.group(1)))
        except (ValueError, TypeError):
            continue
        if row is not None:
            rows.append(row)
    return rows


def run_remote():
    try:
        source = Path('scripts/youtube-lyrics-diagnostic.py').read_bytes()
        sha = os.environ.get('GITHUB_SHA', '')
        if not re.fullmatch(r'[a-fA-F0-9]{40}', sha) or not 0 < len(source) <= 32768:
            raise ValueError('invalid_diagnostic_source')
        url = 'https://raw.githubusercontent.com/sanxlab/hararest/' + sha.lower() + '/scripts/youtube-lyrics-diagnostic.py'
        expected = hashlib.sha256(source).hexdigest()
        # Fetch only this reviewed commit; execute only bytes matching this checkout.
        runner = ('import hashlib,urllib.request;'
                  'r=urllib.request.urlopen(' + repr(url) + ',timeout=10);'
                  's=r.read(32768);r.close();'
                  'assert hashlib.sha256(s).hexdigest()==' + repr(expected) + ';'
                  'exec(compile(s,"<lyrics-diagnostic>","exec"))')
        command = '/opt/media-fallback/bin/python -c ' + shlex.quote(runner)
        if len(command.encode('utf-8')) >= 1000:
            raise ValueError('diagnostic_command_limit')
        created = api_request('/dynos', {
            'attach': False, 'type': 'web',
            'command': command,
            'env': {'HARAREST_TEST_COOKIES_BASE64': os.environ.get('HARAREST_LYRICS_TEST_COOKIES', '')},
        })
        dyno_name, dyno_id = created.get('name'), created.get('id')
        if not isinstance(dyno_name, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', dyno_name):
            raise ValueError('invalid_dyno_response')
        if not isinstance(dyno_id, str) or not re.fullmatch(r'[a-fA-F0-9-]{36}', dyno_id):
            raise ValueError('invalid_dyno_response')
    except Exception as error:
        remote_error('dyno_create_failed', error)
        return 1
    route = '/dynos/' + urllib.parse.quote(dyno_id, safe='')
    deadline = time.monotonic() + 90
    timed_out = False
    last_seen = None
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            timed_out = True
            break
        try:
            last_seen = api_request(route, timeout=min(10, remaining))
            if last_seen.get('state') in ('down', 'crashed'):
                break
        except urllib.error.HTTPError as error:
            if error.code not in (404, 410):
                remote_error('dyno_poll_failed', error)
            break
        except Exception:
            remote_error('dyno_poll_failed')
            break
        time.sleep(min(3, max(0, deadline - time.monotonic())))
    if timed_out:
        remote_error('dyno_wait_timeout')
        # Delete only this exact one-off process, never a web formation dyno.
        if (re.fullmatch(r'run\.\d+', dyno_name) and isinstance(last_seen, dict)
                and last_seen.get('id') == dyno_id and last_seen.get('name') == dyno_name):
            try:
                api_request(route, method='DELETE')
            except urllib.error.HTTPError as error:
                if error.code not in (404, 410):
                    remote_error('dyno_stop_failed', error)
            except Exception:
                remote_error('dyno_stop_failed')
    found = {}
    for attempt in range(3):
        try:
            for row in read_probe_logs(dyno_name):
                if row['probe'] not in found:
                    print(json.dumps(row), flush=True)
                    found[row['probe']] = row
            if set(found) == PROBES:
                return 1 if timed_out else 0
        except Exception as error:
            if attempt == 2:
                remote_error('dyno_log_read_failed', error)
        if attempt < 2:
            time.sleep(3)
    remote_error('probe_rows_missing')
    return 1


raise SystemExit(run_remote())
