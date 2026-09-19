import * as cheerio from 'cheerio';
import { z } from 'zod';
import { AppError } from '../../utils/AppError';
import { getPublicPage } from '../../utils/http';
import { BilibiliMedia, BilibiliOpusResult } from './bilibili.types';
import { bilibiliRequestHeaders } from './bilibili.auth';

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
  return parseOpusState(readInitialState(html), id, headers);
}

function parseOpusState(
  input: unknown,
  id: string,
  headers: BilibiliOpusResult['headers'],
): BilibiliOpusResult {
  const state = z.object({ detail: detailSchema }).safeParse(input);
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
  try {
    const response = await getPublicPage<string>(
      `https://www.bilibili.com/opus/${id}`,
      ['www.bilibili.com'],
      { headers },
    );
    if (typeof response.data !== 'string') throw new AppError('Invalid Bilibili Opus page.', 502);
    return parseBilibiliOpus(response.data, id, headers);
  } catch (error) {
    // Do not use a fallback to override an explicit restriction or an empty post.
    if (error instanceof AppError && error.statusCode !== 502) throw error;
  }
  let body: unknown;
  try {
    const response = await getPublicPage<unknown>(
      `https://api.bilibili.com/x/polymer/web-dynamic/v1/detail?id=${id}`,
      ['api.bilibili.com'],
      { headers: bilibiliRequestHeaders(headers), responseType: 'json' },
    );
    body = response.data;
  } catch {
    throw new AppError(
      'Bilibili Opus page and detail API are unavailable or blocked by upstream. Try again later.',
      502,
    );
  }
  return parseBilibiliDynamic(body, id, headers);
}

const dynamicSchema = z.object({
  id_str: z.string(),
  visible: z.boolean().optional(),
  basic: z.object({ is_only_fans: z.boolean().optional() }).optional(),
  modules: z.object({
    module_author: z.unknown(),
    module_blocked: z.unknown().optional(),
    module_paywall: z.unknown().optional(),
    module_dynamic: z.object({
      desc: z.object({ text: z.string() }).nullish(),
      major: z
        .object({
          type: z.string(),
          blocked: z.unknown().optional(),
          opus: z
            .object({
              title: z.string().nullish(),
              summary: z.object({ text: z.string() }).nullish(),
              pics: z.array(pictureSchema),
            })
            .optional(),
          draw: z
            .object({
              items: z.array(
                z.object({
                  src: z.string(),
                  width: z.number().int().nonnegative().default(0),
                  height: z.number().int().nonnegative().default(0),
                }),
              ),
            })
            .optional(),
        })
        .nullish(),
    }),
  }),
});

export function parseBilibiliDynamic(
  body: unknown,
  id: string,
  headers: BilibiliOpusResult['headers'],
): BilibiliOpusResult {
  const envelope = z.object({ code: z.number(), data: z.unknown().optional() }).safeParse(body);
  if (!envelope.success) throw new AppError('Invalid Bilibili Opus API response.', 502);
  const { code, data } = envelope.data;
  if ([-404, 4101131, 62002].includes(code)) {
    throw new AppError('Bilibili Opus post was not found or is unavailable.', 404);
  }
  if (code === -101) {
    throw new AppError('Bilibili requires a valid BILIBILI_SESSDATA login cookie.', 502);
  }
  if (code !== 0) throw new AppError(`Bilibili Opus API rejected the request (code ${code}).`, 502);
  const parsed = z.object({ item: dynamicSchema }).safeParse(data);
  if (!parsed.success || parsed.data.item.id_str !== id) {
    throw new AppError('Invalid Bilibili Opus API details.', 502);
  }
  const item = parsed.data.item;
  const modules = item.modules;
  const major = modules.module_dynamic.major;
  if (
    item.visible === false ||
    item.basic?.is_only_fans ||
    modules.module_blocked ||
    modules.module_paywall ||
    major?.blocked ||
    major?.type === 'MAJOR_TYPE_BLOCKED'
  ) {
    throw new AppError('This Bilibili Opus post is restricted.', 403);
  }
  const pictures =
    major?.type === 'MAJOR_TYPE_OPUS'
      ? major.opus?.pics
      : major?.type === 'MAJOR_TYPE_DRAW'
        ? major.draw?.items.map(({ src, ...size }) => ({ url: src, ...size }))
        : [];
  return parseOpusState(
    {
      detail: {
        id_str: item.id_str,
        basic: { title: major?.opus?.title || '' },
        modules: [
          { module_author: modules.module_author },
          {
            module_content: {
              paragraphs: [
                {
                  text: {
                    nodes: [
                      {
                        word: {
                          words:
                            modules.module_dynamic.desc?.text || major?.opus?.summary?.text || '',
                        },
                      },
                    ],
                  },
                },
                { pic: { pics: pictures || [] } },
              ],
            },
          },
        ],
      },
    },
    id,
    headers,
  );
}
