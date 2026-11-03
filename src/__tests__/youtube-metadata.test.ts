import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as childProcess from 'child_process';
import { YoutubeService } from '../modules/youtube/youtube.service';

// Use real yt-dlp/FFmpeg postprocessors with offline extractor data. No request
// goes to YouTube, and file:// access is enabled only for these test fixtures.
jest.mock('child_process', () => ({
  ...jest.requireActual('child_process'),
  execFile: jest.fn(),
}));
const realChildProcess = jest.requireActual<typeof childProcess>('child_process');
const execFile = childProcess.execFile as unknown as jest.Mock;
const binary = path.resolve('bin/yt-dlp');
const toolsAvailable = fs.existsSync(binary) && ['ffmpeg', 'ffprobe'].every(
  tool => realChildProcess.spawnSync(tool, ['-version'], { stdio: 'ignore' }).status === 0,
);
const offlineTest = toolsAvailable ? it : it.skip;

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    realChildProcess.execFile(file, args, { timeout: 30_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

offlineTest.each([
  { name: 'music tags, release date and cover', music: true, date: '2020', musicURL: false },
  { name: 'title/channel/date fallback without fabricated music tags', music: false, date: '2024', musicURL: false },
  { name: 'YouTube Music lyrics alongside cover and existing tags', music: true, date: '2020', musicURL: true },
])('writes a real playable MP3 with $name', async ({ music, date, musicURL }) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-id3-'));
  const lyricText = 'Original offline fixture lyric\nAnother original offline line';
  const lyricsRequest = jest.spyOn(globalThis, 'fetch').mockImplementation(async endpoint => {
    const query = new URL(String(endpoint));
    expect(query.origin + query.pathname).toBe('https://lrclib.net/api/get');
    return new Response(JSON.stringify({ trackName: 'Song title', artistName: 'Artist', albumName: 'Album', duration: Number(query.searchParams.get('duration')), instrumental: false, plainLyrics: lyricText }), { headers: { 'content-type': 'application/json' } });
  });
  const targetURL = `https://${musicURL ? 'music' : 'www'}.youtube.com/watch?v=offline`;
  try {
    const source = path.join(directory, 'source.wav');
    const cover = path.join(directory, musicURL ? 'cover.jpg' : 'cover.png');
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', source]);
    if (music) {
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=128x128:duration=1', '-frames:v', '1', '-threads', '1', '-q:v', '2', cover]);
    }
    const metadata = path.join(directory, 'info.json');
    fs.writeFileSync(metadata, JSON.stringify({
      id: 'offline-track', title: 'Video title', uploader: 'Channel name',
      upload_date: '20241105', description: 'Fixture description',
      webpage_url: targetURL,
      extractor: 'generic', extractor_key: 'Generic', ext: 'wav',
      url: pathToFileURL(source).href,
      ...(music ? {
        track: 'Song title', artist: 'Artist', album: 'Album', album_artist: 'Album Artist',
        track_number: 3, disc_number: 1, composer: 'Composer', genre: 'Pop', release_date: '20200102',
        thumbnails: [{ id: 'cover', url: pathToFileURL(cover).href, ext: musicURL ? 'jpg' : 'png' }],
      } : {}),
    }));
    execFile.mockImplementation((file, args, options, callback) => realChildProcess.execFile(
      file, [...(file === binary ? ['--ignore-config', '--load-info-json', metadata, '--enable-file-urls'] : []), ...args], options, callback,
    ));
    const downloads = path.join(directory, 'downloads');
    const service = new YoutubeService(downloads);
    Object.assign(service, { binPath: binary, cookiePath: path.join(directory, 'no-cookies') });
    const output = await service.downloadAudio(targetURL);
    const probe = JSON.parse(await run('ffprobe', [
      '-v', 'error', '-show_entries', 'format_tags:stream=codec_type,codec_name,width,height:stream_disposition=attached_pic', '-of', 'json', output,
    ])) as {
      format: { tags: Record<string, string> };
      streams: Array<{ codec_type: string; codec_name: string; width?: number; height?: number; disposition: { attached_pic: number } }>;
    };
    expect(probe.streams).toEqual(expect.arrayContaining([expect.objectContaining({ codec_name: 'mp3', codec_type: 'audio' })]));
    expect(probe.format.tags).toMatchObject({
      title: music ? 'Song title' : 'Video title', artist: music ? 'Artist' : 'Channel name',
      date, purl: targetURL, description: 'Fixture description',
    });
    if (music) {
      expect(probe.format.tags).toMatchObject({ album: 'Album', album_artist: 'Album Artist', track: '3', disc: '1', composer: 'Composer', genre: 'Pop' });
      expect(probe.streams).toEqual(expect.arrayContaining([
        expect.objectContaining({ codec_name: 'mjpeg', width: 128, height: 128, disposition: { attached_pic: 1 } }),
      ]));
    } else {
      expect(probe.format.tags.album).toBeUndefined();
      expect(probe.format.tags.track).toBeUndefined();
      expect(probe.format.tags.genre).toBeUndefined();
      expect(probe.streams).toHaveLength(1);
    }
    if (musicURL) {
      expect(Object.entries(probe.format.tags).find(([key]) => /^lyrics(?:-|$)/i.test(key))?.[1]).toBe(lyricText);
      expect(lyricsRequest).toHaveBeenCalledTimes(1);
    } else {
      expect(lyricsRequest).not.toHaveBeenCalled();
    }
    // The delivered file remains decodable after writing ID3 and cover frames.
    await run('ffmpeg', ['-v', 'error', '-i', output, '-map', '0:a:0', '-f', 'null', '-']);
    expect(fs.readdirSync(downloads)).toEqual([path.basename(output)]);
  } finally {
    lyricsRequest.mockRestore();
    execFile.mockReset();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
