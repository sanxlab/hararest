import axios from 'axios';
import { z } from 'zod';
import { assertPublicUrl } from '../../middlewares/ssrf.middleware';
import { AppError } from '../../utils/AppError';
import { getPublicPage } from '../../utils/http';
import { publicHttpAgent, publicHttpsAgent } from '../../utils/publicAgent';
import { queryInteger } from '../../utils/query';
import { BilibiliMedia, BilibiliResult, BilibiliOpusResult } from './bilibili.types';
import { downloadBilibiliOpus } from './bilibili.opus';
import { bilibiliRequestHeaders } from './bilibili.auth';

export const BILIBILI_HOSTS = [
  'bilibili.com',
  'www.bilibili.com',
  'm.bilibili.com',
  'b23.tv',
  'bili2233.cn',
] as const;
const HEADERS = {
  Referer: 'https://www.bilibili.com/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};
const QUALITIES: Record<string, number> = {
  '360p': 16,
  '480p': 32,
  '720p': 64,
  '720p60': 74,
  '1080p': 80,
  '1080p60': 116,
  '4k': 120,
};
const positiveId = z.number().int().positive().safe();
const pageSchema = z.object({
  cid: positiveId,
  page: positiveId,
  part: z.string(),
  duration: z.number(),
});
const viewSchema = z.object({
  bvid: z.string().regex(/^BV[0-9A-Za-z]{10}$/),
  aid: positiveId,
  title: z.string(),
  desc: z.string().default(''),
  pic: z.string().default(''),
  pubdate: z.number().default(0),
  owner: z.object({ mid: z.number(), name: z.string(), face: z.string().default('') }),
  pages: z.array(pageSchema).min(1),
});
const streamSchema = z.object({
  id: z.number(),
  baseUrl: z.string().optional(),
  base_url: z.string().optional(),
  backupUrl: z.array(z.string()).optional(),
  backup_url: z.array(z.string()).optional(),
  mimeType: z.string().optional(),
  mime_type: z.string().optional(),
  codecs: z.string().default(''),
  bandwidth: z.number().default(0),
  width: z.number().optional(),
  height: z.number().optional(),
});
const playSchema = z.object({
  quality: z.number(),
  format: z.string().default(''),
  accept_quality: z.array(z.number()).default([]),
  accept_description: z.array(z.string()).default([]),
  dash: z
    .object({
      video: z.array(streamSchema).default([]),
      audio: z.array(streamSchema).nullable().optional(),
    })
    .nullable()
    .optional(),
  durl: z
    .array(
      z.object({
        url: z.string(),
        backup_url: z.array(z.string()).nullable().optional(),
        size: z.number().optional(),
        order: z.number(),
        length: z.number().optional(),
      }),
    )
    .optional(),
});
const envelopeSchema = z.object({ code: z.number(), data: z.unknown().optional() });

function mediaUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

export class BilibiliService {
  private async api<T>(
    paths: string[],
    params: Record<string, string | number>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const headers = bilibiliRequestHeaders(HEADERS);
    for (const [index, path] of paths.entries()) {
      let body: unknown;
      try {
        const response = await axios.get<unknown>(`https://api.bilibili.com${path}`, {
          params,
          headers,
          timeout: 15000,
          maxContentLength: 5 * 1024 * 1024,
          maxRedirects: 0,
          proxy: false,
          httpAgent: publicHttpAgent,
          httpsAgent: publicHttpsAgent,
        });
        body = response.data;
      } catch {
        if (index < paths.length - 1) continue;
        throw new AppError(
          'Bilibili request failed or was blocked by upstream. Try again later.',
          502,
        );
      }
      const envelope = envelopeSchema.safeParse(body);
      if (!envelope.success) throw new AppError('Invalid response from Bilibili.', 502);
      const { code, data } = envelope.data;
      if (code === -404 || code === 62002)
        throw new AppError('Bilibili video was not found or is unavailable.', 404);
      if (code === -101)
        throw new AppError('Bilibili requires a valid BILIBILI_SESSDATA login cookie.', 502);
      if (code !== 0) {
        if ([-352, -412, -509].includes(code) && index < paths.length - 1) continue;
        throw new AppError(`Bilibili API rejected the request (code ${code}).`, 502);
      }
      const parsed = schema.safeParse(data);
      if (!parsed.success) throw new AppError('Invalid media data from Bilibili.', 502);
      return parsed.data;
    }
    throw new AppError('Bilibili is unavailable.', 502);
  }

  async download(
    rawUrl: string,
    quality = '1080p',
    requestedPage?: string,
  ): Promise<BilibiliResult | BilibiliOpusResult> {
    const key = quality.toLowerCase();
    const qn = Object.hasOwn(QUALITIES, key) ? QUALITIES[key] : undefined;
    if (!qn)
      throw new AppError(`Invalid quality. Choose ${Object.keys(QUALITIES).join(', ')}.`, 400);
    let url = await assertPublicUrl(rawUrl, BILIBILI_HOSTS);
    if (!BILIBILI_HOSTS.some((host) => host === url.hostname))
      throw new AppError('Unsupported Bilibili domain.', 400);
    if (['b23.tv', 'bili2233.cn'].includes(url.hostname)) {
      try {
        const response = await getPublicPage<string>(url.toString(), BILIBILI_HOSTS, {
          headers: HEADERS,
        });
        url = await assertPublicUrl(response.config.url || url.toString(), BILIBILI_HOSTS);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw new AppError('Unable to resolve Bilibili short link.', 502);
      }
    }
    const opus = /^\/opus\/([1-9]\d{0,24})\/?$/.exec(url.pathname);
    if (opus && ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(url.hostname)) {
      if (requestedPage !== undefined)
        throw new AppError('The page parameter is only supported for videos.', 400);
      return downloadBilibiliOpus(opus[1], HEADERS);
    }
    const match = /^\/video\/(BV[0-9A-Za-z]{10}|av[1-9]\d*)\/?$/.exec(url.pathname);
    if (!['bilibili.com', 'www.bilibili.com', 'm.bilibili.com'].includes(url.hostname) || !match) {
      throw new AppError('Use a bilibili.com/video/BV..., /video/av..., or /opus/... URL.', 400);
    }
    const urlPages = url.searchParams.getAll('p');
    if (urlPages.length > 1)
      throw new AppError('Bilibili URL must contain only one p parameter.', 400);
    const pageNumber = queryInteger(requestedPage ?? urlPages[0], 'page', 1, 10000);
    const id = match[1];
    const identity: Record<string, string> = id.startsWith('BV')
      ? { bvid: id }
      : { aid: id.slice(2) };
    const info = await this.api(
      ['/x/web-interface/wbi/view', '/x/web-interface/view'],
      identity,
      viewSchema,
    );
    const page = info.pages.find((item) => item.page === pageNumber);
    if (!page) throw new AppError('Requested Bilibili video page does not exist.', 400);
    const play = await this.api(
      ['/x/player/playurl', '/x/player/wbi/playurl'],
      {
        bvid: info.bvid,
        cid: page.cid,
        qn,
        fnval: 4048,
        fourk: 1,
      },
      playSchema,
    );
    const label = (id: number) =>
      play.accept_description[play.accept_quality.indexOf(id)] ||
      Object.keys(QUALITIES).find((key) => QUALITIES[key] === id) ||
      String(id);
    const media: BilibiliMedia[] = [];
    for (const type of ['video', 'audio'] as const) {
      for (const stream of play.dash?.[type] || []) {
        const source = mediaUrl(stream.baseUrl || stream.base_url);
        if (!source) continue;
        media.push({
          type,
          quality: stream.id,
          label:
            type === 'video' ? label(stream.id) : `${Math.round(stream.bandwidth / 1000)} kbps`,
          url: source,
          backupUrls: (stream.backupUrl || stream.backup_url || []).flatMap(
            (value) => mediaUrl(value) || [],
          ),
          mimeType: stream.mimeType || stream.mime_type || `${type}/mp4`,
          codecs: stream.codecs,
          bandwidth: stream.bandwidth,
          ...(type === 'video' ? { width: stream.width, height: stream.height } : {}),
        });
      }
    }
    const dash = media.some((item) => item.type === 'video');
    if (!dash) {
      media.length = 0;
      for (const segment of play.durl || []) {
        const source = mediaUrl(segment.url);
        if (!source) throw new AppError('Invalid Bilibili media URL.', 502);
        media.push({
          type: 'muxed',
          quality: play.quality,
          label: label(play.quality),
          url: source,
          backupUrls: (segment.backup_url || []).flatMap((value) => mediaUrl(value) || []),
          mimeType: play.format.includes('mp4') ? 'video/mp4' : 'video/x-flv',
          codecs: '',
          bandwidth: 0,
          size: segment.size,
          order: segment.order,
          duration: segment.length === undefined ? undefined : segment.length / 1000,
        });
      }
    }
    if (!media.length)
      throw new AppError(
        'Bilibili returned no playable media. Login or regional access may be required.',
        502,
      );
    media.sort((a, b) => {
      if (!dash) return (a.order || 0) - (b.order || 0);
      if (a.type !== b.type) return a.type === 'video' ? -1 : 1;
      return b.quality - a.quality || b.bandwidth - a.bandwidth;
    });
    return {
      id: info.bvid,
      aid: info.aid,
      url: `https://www.bilibili.com/video/${info.bvid}/?p=${page.page}`,
      title: info.title,
      description: info.desc,
      thumbnail: info.pic,
      author: { id: info.owner.mid, name: info.owner.name, avatar: info.owner.face },
      uploaded: info.pubdate,
      duration: page.duration,
      page: page.page,
      cid: page.cid,
      pages: info.pages.map((item) => ({
        cid: item.cid,
        page: item.page,
        title: item.part,
        duration: item.duration,
      })),
      requestedQuality: qn,
      availableQualities: [
        ...new Set(media.filter((item) => item.type !== 'audio').map((item) => item.quality)),
      ],
      format: dash ? 'dash' : 'progressive',
      requiresMerge: dash ? media.some((item) => item.type === 'audio') : media.length > 1,
      media,
      headers: { ...HEADERS },
    };
  }
}
