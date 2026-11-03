const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { pathToFileURL } = require('node:url');
const { YoutubeService } = require(path.resolve('dist/modules/youtube/youtube.service'));
const { config } = require(path.resolve('dist/config/default'));
const run = promisify(execFile);

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hararest-mp3-smoke-'));
  const originalFetch = globalThis.fetch;
  try {
    const source = path.join(directory, 'source.wav');
    const cover = path.join(directory, 'cover.png');
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', source]);
    await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64', '-frames:v', '1', '-threads', '1', cover]);
    const binary = path.resolve(config.youtube.binPath);
    const infoFile = path.join(directory, 'info.json');
    const shim = path.join(directory, 'offline-yt-dlp');
    // Enable local fixture URLs only in this verification process, never in the API.
    const args = [binary, '--ignore-config', '--load-info-json', infoFile, '--enable-file-urls'];
    fs.writeFileSync(shim, `#!/usr/bin/env python3\nimport os, sys\nargs = ${JSON.stringify(args)}\nos.execv(args[0], args + sys.argv[1:])\n`, { mode: 0o700 });
    const lyricText = 'Original production fixture lyric\nAnother original fixture line';
    const lrcText = '[00:00.00]Original production fixture lyric\n[00:00.45]Another original fixture line';
    globalThis.fetch = async endpoint => {
      const query = new URL(String(endpoint));
      assert.equal(query.origin + query.pathname, 'https://lrclib.net/api/get');
      return new Response(JSON.stringify({ trackName: 'Song', artistName: 'Artist', albumName: 'Album', duration: Number(query.searchParams.get('duration')), instrumental: false, plainLyrics: lyricText, syncedLyrics: lrcText }), { headers: { 'content-type': 'application/json' } });
    };
    for (const music of [true, false]) {
      const url = `https://${music ? 'music' : 'www'}.youtube.com/watch?v=offline`;
      fs.writeFileSync(infoFile, JSON.stringify({
        id: 'offline', title: 'Video title', uploader: 'Channel', upload_date: '20241105',
        webpage_url: url, extractor: 'generic', extractor_key: 'Generic', ext: 'wav',
        url: pathToFileURL(source).href,
        ...(music ? {
          track: 'Song', artist: 'Artist', album: 'Album', album_artist: 'Album Artist',
          composer: 'Composer', genre: 'Pop', track_number: 3, disc_number: 1, release_date: '20200102',
          thumbnails: [{ id: 'cover', url: pathToFileURL(cover).href, ext: 'png' }],
        } : {}),
      }));
      const service = new YoutubeService(path.join(directory, music ? 'music' : 'fallback'));
      Object.assign(service, { binPath: shim, cookiePath: path.join(directory, 'no-cookies') });
      const output = await service.downloadAudio(url);
      const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format_tags:stream=codec_name,codec_type,width,height:stream_disposition=attached_pic', '-of', 'json', output]);
      const { format, streams } = JSON.parse(stdout);
      assert.equal(format.tags.title, music ? 'Song' : 'Video title');
      assert.equal(format.tags.artist, music ? 'Artist' : 'Channel');
      assert.equal(format.tags.date, music ? '2020' : '2024');
      assert.equal(format.tags.purl, url);
      assert.ok(streams.some(s => s.codec_type === 'audio' && s.codec_name === 'mp3'));
      if (music) {
        assert.equal(Object.entries(format.tags).find(([key]) => /^lyrics(?:-|$)/i.test(key))?.[1], lrcText);
        const tags = fs.readFileSync(output);
        assert.equal(tags.toString('ascii', 10, 14), 'USLT');
        const frameSize = offset => tags[3] === 3 ? tags.readUInt32BE(offset + 4)
          : tags[offset + 4] * 0x200000 + tags[offset + 5] * 0x4000 + tags[offset + 6] * 0x80 + tags[offset + 7];
        const syltOffset = 20 + frameSize(10);
        assert.equal(tags.toString('ascii', syltOffset, syltOffset + 4), 'SYLT');
        assert.equal(tags[syltOffset + 14], 2); // millisecond timestamps
        const sylt = tags.subarray(syltOffset + 10, syltOffset + 10 + frameSize(syltOffset));
        let cursor = 10;
        for (const [text, timeMs] of [['Original production fixture lyric', 0], ['Another original fixture line', 450]]) {
          let end = cursor;
          while (sylt.readUInt16LE(end) !== 0) end += 2;
          assert.equal(sylt.toString('utf16le', cursor, end).replace(/^\uFEFF/, ''), text);
          assert.equal(sylt.readUInt32BE(end + 2), timeMs);
          cursor = end + 6;
        }
        for (const [key, value] of Object.entries({ album: 'Album', album_artist: 'Album Artist', composer: 'Composer', genre: 'Pop', track: '3', disc: '1' })) {
          assert.equal(format.tags[key], value);
        }
        assert.ok(streams.some(s => s.codec_name === 'mjpeg' && s.width === 64 && s.height === 64 && s.disposition.attached_pic === 1));
      } else {
        assert.equal(format.tags.album, undefined);
        assert.equal(format.tags.track, undefined);
        assert.equal(streams.length, 1);
      }
      await run('ffmpeg', ['-v', 'error', '-i', output, '-map', '0:a:0', '-f', 'null', '-']);
    }
    console.log('Production MP3 tags, cover art, embedded lyrics, fallback metadata, and audio decoding passed');
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
