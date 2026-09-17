import * as cheerio from 'cheerio';
import { z } from 'zod';
import { AppError } from '../../utils/AppError';
import { getPublicPage } from '../../utils/http';
import { BilibiliMedia, BilibiliOpusResult } from './bilibili.types';

const pictureSchema = z.object({
  url: z.string(),
  width: z.number().int().nonnegative().default(0),
  height: z.number().int().nonnegative().default(0),
});
const detailSchema = z.object({
  id_str: z.string().regex(/^[1-9]\d*$/),
  basic: z.object({ title: z.string().default(''), is_only_fans: z.boolean().optional() }),
  modules: z.array(
    z.object({
      module_author: z
        .object({
          mid: z.number().int().nonnegative().safe(),
          name: z.string(),
          face: z.string().default(''),
          pub_ts: z.coerce.number().int().nonnegative().default(0),
        })
        .nullish(),
      module_title: z.object({ text: z.string().default('') }).nullish(),
      module_blocked: z.unknown().optional(),
      module_paywall: z.unknown().optional(),
      module_content: z
        .object({
          paragraphs: z.array(
            z.object({
              pic: z.object({ pics: z.array(pictureSchema) }).nullish(),
              text: z
                .object({
                  nodes: z.array(
                    z.object({
                      word: z.object({ words: z.string() }).nullish(),
                      rich: z.object({ text: z.string() }).nullish(),
                    }),
                  ),
                })
                .nullish(),
            }),
          ),
        })
        .nullish(),
    }),
  ),
});

// Read only the JSON object, never execute the JavaScript after the assignment.
function readInitialState(html: string): unknown {
  const $ = cheerio.load(html);
  for (const element of $('script').toArray()) {
    const script = $(element).html() || '';
    const assignment = /^\s*window\.__INITIAL_STATE__\s*=\s*/.exec(script);
    if (!assignment) continue;
    const start = assignment[0].length;
    if (script[start] !== '{') break;
    let depth = 0,
      quoted = false,
      escaped = false;
    for (let i = start; i < script.length; i++) {
      const char = script[i];
      if (quoted) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') quoted = false;
      } else if (char === '"') quoted = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try {
          return JSON.parse(script.slice(start, i + 1));
        } catch {
          throw new AppError('Invalid Bilibili Opus page data.', 502);
        }
      }
    }
    break;
  }
  throw new AppError(
    'Bilibili Opus data is unavailable. The post may require login or have been removed.',
    502,
  );
}

export function parseBilibiliOpus(
  html: string,
  id: string,
  headers: BilibiliOpusResult['headers'],
): BilibiliOpusResult {
  const state = z.object({ detail: detailSchema }).safeParse(readInitialState(html));
  if (!state.success || state.data.detail.id_str !== id)
    throw new AppError('Invalid Bilibili Opus details.', 502);
  const detail = state.data.detail;
  if (
    detail.basic.is_only_fans ||
    detail.modules.some((item) => item.module_blocked || item.module_paywall)
  ) {
    throw new AppError('This Bilibili Opus post is restricted.', 403);
  }
  const author = detail.modules.find((item) => item.module_author)?.module_author;
  if (!author) throw new AppError('Bilibili Opus author is unavailable.', 502);
  const paragraphs = detail.modules.flatMap((item) => item.module_content?.paragraphs || []);
  const description = paragraphs
    .map((item) =>
      (item.text?.nodes || []).map((node) => node.word?.words || node.rich?.text || '').join(''),
    )
    .filter(Boolean)
    .join('\n');
  const media: BilibiliMedia[] = [];
  const seen = new Set<string>();
  for (const picture of paragraphs.flatMap((item) => item.pic?.pics || [])) {
    let source: URL;
    try {
      source = new URL(picture.url.startsWith('//') ? `https:${picture.url}` : picture.url);
    } catch {
      throw new AppError('Invalid Opus image URL.', 502);
    }
    if (
      !['http:', 'https:'].includes(source.protocol) ||
      source.username ||
      source.password ||
      source.port ||
      !(source.hostname === 'hdslb.com' || source.hostname.endsWith('.hdslb.com')) ||
      !source.pathname.startsWith('/bfs/')
    ) {
      throw new AppError('Unsupported Opus image URL.', 502);
    }
    source.protocol = 'https:';
    source.pathname = source.pathname.split('@')[0];
    const extension = /\.(gif|png|jpe?g|webp)$/i.exec(source.pathname)?.[1].toLowerCase();
    if (!extension) throw new AppError('Unsupported Opus image format.', 502);
    const url = source.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    const gif = extension === 'gif';
    media.push({
      type: gif ? 'gif' : 'image',
      url,
      quality: 0,
      label: gif ? 'GIF' : 'Original',
      backupUrls: [],
      mimeType: `image/${extension === 'jpg' ? 'jpeg' : extension}`,
      codecs: '',
      bandwidth: 0,
      width: picture.width,
      height: picture.height,
      order: media.length + 1,
    });
  }
  if (!media.length) throw new AppError('No images or GIFs found in this Bilibili Opus post.', 404);
  return {
    id,
    url: `https://www.bilibili.com/opus/${id}`,
    title:
      detail.modules.find((item) => item.module_title)?.module_title?.text || detail.basic.title,
    description,
    thumbnail: media[0].url,
    author: { id: author.mid, name: author.name, avatar: author.face },
    uploaded: author.pub_ts,
    format: 'images',
    requiresMerge: false,
    media,
    headers: { ...headers },
  };
}

export async function downloadBilibiliOpus(
  id: string,
  headers: BilibiliOpusResult['headers'],
): Promise<BilibiliOpusResult> {
  let html: string;
  try {
    const response = await getPublicPage<string>(
      `https://www.bilibili.com/opus/${id}`,
      ['www.bilibili.com'],
      { headers },
    );
    html = response.data;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'Unable to fetch Bilibili Opus. The post may be unavailable or blocked.',
      502,
    );
  }
  if (typeof html !== 'string') throw new AppError('Invalid Bilibili Opus page.', 502);
  return parseBilibiliOpus(html, id, headers);
}
