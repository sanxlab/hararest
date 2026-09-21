import { load } from 'cheerio';
import { RedditMedia } from './reddit.types';
import { mediaUrl } from './reddit.urls';

// Reddit DASH representations contain complete MP4 files with separate audio.
// Segmented streams are deliberately not advertised as downloadable MP4s.
export function parseRedditDash(xml: string, manifest: string, isGif: boolean): RedditMedia[] {
  const $ = load(xml, { xmlMode: true });
  const videos: RedditMedia[] = [];
  const audio: { url: string; bandwidth: number }[] = [];
  $('Representation').each((_i, element) => {
    const rep = $(element);
    const adaptation = rep.parent();
    if (
      rep.find('SegmentTemplate, SegmentList').length ||
      adaptation.children('SegmentTemplate, SegmentList').length
    )
      return;
    let base = manifest;
    const ancestors = rep.parents().toArray().reverse();
    for (const ancestor of [...ancestors, element]) {
      const part = $(ancestor).children('BaseURL').first().text().trim();
      if (part) {
        const url = mediaUrl(part, base);
        if (!url) return;
        base = url;
      }
    }
    const url = mediaUrl(base);
    if (!url || !/\.mp4$/i.test(new URL(url).pathname)) return;
    const mime = rep.attr('mimeType') || adaptation.attr('mimeType') || '';
    const kind = rep.attr('contentType') || adaptation.attr('contentType') || mime.split('/')[0];
    if (kind === 'audio' && (mime === 'audio/mp4' || !mime)) {
      audio.push({ url, bandwidth: Number(rep.attr('bandwidth')) || 0 });
    } else if (kind === 'video' && (mime === 'video/mp4' || !mime)) {
      const quality = Number(rep.attr('height')) || 0;
      videos.push({
        url,
        type: 'video',
        format: 'mp4',
        quality: `${quality}p`,
        quality_number: quality,
        requires_conversion: false,
        has_audio: false,
        audio_url: null,
        is_gif: isGif,
      });
    }
  });
  const audioURL = isGif ? null : audio.sort((a, b) => b.bandwidth - a.bandwidth)[0]?.url || null;
  return videos
    .map((item) => ({ ...item, audio_url: audioURL }))
    .sort((a, b) => b.quality_number - a.quality_number);
}
