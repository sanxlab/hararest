import * as cheerio from 'cheerio';
import { getPublicPage } from '../../utils/http';
import { AppError } from '../../utils/AppError';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : undefined;

export interface YoutubePost {
  id: string;
  url: string;
  text: string;
  author: string;
  photos: Array<{ url: string }>;
  videoUrl?: string;
}

export function youtubePostId(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new AppError('Invalid YouTube post URL.', 400); }
  const match = /^\/post\/(Ug[A-Za-z0-9_-]{10,100})\/?$/.exec(url.pathname);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
      !['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(url.hostname) || !match) {
    throw new AppError('Invalid YouTube post URL.', 400);
  }
  return match[1];
}

// Parse JSON only. Never evaluate script content supplied by the upstream page.
function initialData(html: string): unknown {
  const $ = cheerio.load(html);
  let result: unknown;
  $('script').each((_, script) => {
    if (result !== undefined) return;
    const source = $(script).html() || '';
    const match = /(?:var\s+ytInitialData|window\["ytInitialData"\]|ytInitialData)\s*=\s*/.exec(source);
    if (!match) return;
    const start = match.index + match[0].length;
    if (source[start] !== '{') return;
    let depth = 0, quoted = false, escaped = false;
    for (let i = start; i < source.length; i++) {
      const char = source[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try { result = JSON.parse(source.slice(start, i + 1)); } catch { /* Invalid upstream JSON. */ }
        return;
      }
    }
  });
  return result;
}

function findPost(value: unknown, id: string): ObjectValue | undefined {
  // Iterative traversal avoids recursive stack exhaustion on upstream data.
  const pending: unknown[] = [value];
  while (pending.length) {
    const next = pending.pop();
    if (Array.isArray(next)) { for (const item of next) pending.push(item); continue; }
    const node = object(next);
    if (!node) continue;
    const post = object(node.backstagePostRenderer) ?? object(node.postRenderer);
    if (post?.postId === id) return post;
    for (const item of Object.values(node)) pending.push(item);
  }
  return undefined;
}

function text(value: unknown): string {
  const data = object(value);
  if (typeof data?.simpleText === 'string') return data.simpleText;
  return Array.isArray(data?.runs) ? data.runs.map(run => {
    const item = object(run);
    return typeof item?.text === 'string' ? item.text : '';
  }).join('') : '';
}

function imageUrl(value: unknown): string | undefined {
  const thumbnails = object(value)?.thumbnails;
  if (!Array.isArray(thumbnails)) return;
  const candidates = thumbnails.map(object).filter((item): item is ObjectValue => !!item && typeof item.url === 'string');
  candidates.sort((a, b) => Number(b.width || 0) * Number(b.height || 0) - Number(a.width || 0) * Number(a.height || 0));
  for (const item of candidates) {
    try {
      const url = new URL(item.url as string);
      if (url.protocol !== 'https:' || url.username || url.password || url.port ||
          !['yt3.ggpht.com', 'yt3.googleusercontent.com'].includes(url.hostname)) continue;
      // Thumbnail renditions are square crops. Request the full original image.
      url.pathname = url.pathname.replace(/=.+$/, '=s0');
      return url.toString();
    } catch { /* Ignore malformed image descriptors. */ }
  }
}

export function parseYoutubePost(html: string, id: string): YoutubePost {
  const post = findPost(initialData(html), id);
  if (!post) throw new AppError('YouTube post not found or unavailable.', 404);
  const attachment = object(post.backstageAttachment);
  const multi = object(attachment?.postMultiImageRenderer);
  const images = Array.isArray(multi?.images) ? multi.images : attachment?.backstageImageRenderer ? [attachment] : [];
  if (images.length > 20) throw new AppError('YouTube post has too many images (maximum 20).', 422);
  const urls = images.map(item => imageUrl(object(object(item)?.backstageImageRenderer)?.image)).filter((url): url is string => !!url);
  const video = object(attachment?.videoRenderer);
  const videoId = typeof video?.videoId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(video.videoId) ? video.videoId : undefined;
  if (!urls.length && !videoId) throw new AppError('Post YouTube ini tidak memiliki gambar atau video yang bisa diunduh.', 422);
  return {
    id, url: `https://www.youtube.com/post/${id}`,
    text: text(post.contentText), author: text(post.authorText),
    photos: [...new Set(urls)].map(url => ({ url })),
    ...(videoId ? { videoUrl: `https://www.youtube.com/watch?v=${videoId}` } : {}),
  };
}

export async function getYoutubePost(input: string): Promise<YoutubePost> {
  const id = youtubePostId(input);
  try {
    const response = await getPublicPage<string>(`https://www.youtube.com/post/${id}?hl=en`, ['youtube.com'], {
      responseType: 'text', headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' },
    });
    return parseYoutubePost(response.data, id);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('Gagal mengambil post YouTube. Coba lagi sebentar.', 502);
  }
}
