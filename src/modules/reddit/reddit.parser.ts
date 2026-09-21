import { z } from 'zod';
import { AppError } from '../../utils/AppError';
import { RedditMedia } from './reddit.types';
import { mediaUrl } from './reddit.urls';

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const number = (v: unknown): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0;
const listing = z
  .array(
    z.object({
      data: z.object({
        children: z.array(z.object({ kind: z.string(), data: z.record(z.string(), z.unknown()) })),
      }),
    }),
  )
  .min(1);

export function imageMedia(raw: unknown, mime?: unknown, animated = false): RedditMedia | null {
  const url = mediaUrl(raw);
  if (!url) return null;
  const parsedURL = new URL(url);
  const path = parsedURL.pathname.toLowerCase();
  const requestedFormat = parsedURL.searchParams.get('format')?.toLowerCase();
  const format =
    (requestedFormat && ['mp4', 'gif', 'webp', 'png', 'jpg'].includes(requestedFormat)
      ? requestedFormat
      : '') ||
    /\.(jpg|jpeg|png|webp|gif|mp4)$/.exec(path)?.[1] ||
    (
      {
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/webp': 'webp',
        'image/gif': 'gif',
      } as Record<string, string>
    )[text(mime)];
  if (!format) return null;
  return {
    url,
    type: format === 'mp4' ? 'video' : 'image',
    format,
    quality: 'original',
    quality_number: 0,
    requires_conversion: false,
    has_audio: false,
    audio_url: null,
    is_gif: animated || format === 'gif',
  };
}

function extract(post: Record<string, unknown>): {
  media: RedditMedia[];
  dash: string | null;
  duration: number | null;
  gallery: boolean;
} {
  const gallery = obj(post.gallery_data).items;
  const metadata = obj(post.media_metadata);
  if (Array.isArray(gallery)) {
    const media: RedditMedia[] = [];
    for (const item of gallery.slice(0, 20)) {
      const data = obj(metadata[text(obj(item).media_id)]);
      if (data.status !== 'valid') continue;
      const source = obj(data.s);
      const animated = data.e === 'AnimatedImage';
      const result = imageMedia(
        animated ? source.mp4 || source.gif || source.u : source.u,
        data.m,
        animated,
      );
      if (result) media.push(result);
    }
    return { media, dash: null, duration: null, gallery: true };
  }
  const video = obj(obj(post.secure_media).reddit_video ?? obj(post.media).reddit_video);
  const fallback = mediaUrl(video.fallback_url);
  const dash = mediaUrl(video.dash_url);
  if (fallback || dash) {
    return {
      media: fallback
        ? [
            {
              url: fallback,
              type: 'video',
              format: 'mp4',
              quality: `${number(video.height)}p`,
              quality_number: number(video.height),
              requires_conversion: false,
              has_audio: false,
              audio_url: null,
              is_gif: video.is_gif === true,
            },
          ]
        : [],
      dash,
      duration: typeof video.duration === 'number' ? number(video.duration) : null,
      gallery: false,
    };
  }
  const direct = imageMedia(post.url_overridden_by_dest || post.url);
  // Only use preview variants for an actual image post, never a linked article's thumbnail.
  const images = obj(post.preview).images;
  const preview = Array.isArray(images) ? obj(images[0]) : {};
  const gifVideo = obj(obj(preview.variants).mp4).source;
  if (direct?.format === 'gif') {
    const animated = imageMedia(obj(gifVideo).url, undefined, true);
    if (animated) return { media: [animated], dash: null, duration: null, gallery: false };
  }
  const image = direct || (post.post_hint === 'image' ? imageMedia(obj(preview.source).url) : null);
  return { media: image ? [image] : [], dash: null, duration: null, gallery: false };
}

export function parseRedditPost(body: unknown, expectedId: string) {
  const parsed = listing.safeParse(body);
  if (!parsed.success)
    throw new AppError('Invalid response from Reddit. API access may be blocked.', 502);
  const post = parsed.data[0].data.children.find(
    (item) => item.kind === 't3' && text(item.data.id).toLowerCase() === expectedId.toLowerCase(),
  )?.data;
  if (!post) throw new AppError('Reddit post was not found or is unavailable.', 404);
  let current = post;
  let extracted = extract(current);
  for (let depth = 0; depth < 5 && !extracted.media.length && !extracted.dash; depth++) {
    const parents = current.crosspost_parent_list;
    if (!Array.isArray(parents) || !parents.length) break;
    current = obj(parents[0]);
    extracted = extract(current);
  }
  const seen = new Set<string>();
  extracted.media = extracted.media.filter((item) => !seen.has(item.url) && !!seen.add(item.url));
  const images = obj(current.preview).images;
  const thumbnail =
    mediaUrl(current.thumbnail) ||
    (Array.isArray(images) ? mediaUrl(obj(obj(images[0]).source).url) : null);
  return { ...extracted, title: text(post.title), uploader: text(post.author), thumbnail };
}
