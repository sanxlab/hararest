import * as cheerio from 'cheerio';
import { AppError } from '../../utils/AppError';
import { ThreadsDownloadResult, ThreadsMediaItem, ThreadsMediaType } from './threads.types';

const THREADSTER_HOME = 'https://threadster.app/';
const THREADSTER_DOWNLOAD = 'https://threadster.app/download';
const DEFAULT_TIMEOUT_MS = 45000;
const USER_AGENT =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export class ThreadsService {
    private normalizeThreadsUrl(rawUrl: string): string {
        const value = rawUrl.trim();
        if (!value) {
            return '';
        }

        try {
            const parsed = new URL(value);
            if (!/^https?:$/.test(parsed.protocol)) {
                return '';
            }

            const hostname = parsed.hostname.toLowerCase();
            const isThreadsHost =
                hostname === 'threads.net' ||
                hostname.endsWith('.threads.net') ||
                hostname === 'threads.com' ||
                hostname.endsWith('.threads.com');

            if (!isThreadsHost) {
                return '';
            }

            return parsed.toString();
        } catch {
            return '';
        }
    }

    private async fetchWithTimeout(url: string, options: RequestInit, timeoutMs: number): Promise<Response> {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(timeout);
        }
    }

    private extractCookieHeader(response: Response): string {
        const headers = response.headers as Headers & { getSetCookie?: () => string[] };
        const setCookies =
            typeof headers.getSetCookie === 'function'
                ? headers.getSetCookie()
                : this.splitSetCookieHeader(headers.get('set-cookie') || '');

        return setCookies
            .map((cookie) => cookie.split(';')[0].trim())
            .filter(Boolean)
            .join('; ');
    }

    private splitSetCookieHeader(header: string): string[] {
        if (!header) return [];
        return header.split(/,(?=\s*[^;,]+=)/g);
    }

    private assertOk(response: Response, message: string): void {
        if (!response.ok) {
            throw new AppError(`${message}: HTTP ${response.status} ${response.statusText}`, 502);
        }
    }

    private cleanText(value: string): string {
        return value
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
            .join('\n')
            .trim();
    }

    private inferMediaType(label: string): ThreadsMediaType {
        const lowered = label.toLowerCase();
        if (lowered.includes('video')) return 'video';
        if (lowered.includes('gif')) return 'gif';
        if (lowered.includes('image') || lowered.includes('photo')) return 'image';
        return 'media';
    }

    private decodeThreadsterToken(downloadUrl: string): string | undefined {
        try {
            const token = new URL(downloadUrl).searchParams.get('token');
            if (!token) return undefined;

            const payload = token.split('.')[1];
            if (!payload) return undefined;

            const decoded = Buffer.from(payload, 'base64url').toString('utf8');
            const data = JSON.parse(decoded) as { url?: unknown };
            return typeof data.url === 'string' ? data.url : undefined;
        } catch {
            return undefined;
        }
    }

    private removeEmpty(item: ThreadsMediaItem): ThreadsMediaItem {
        return Object.fromEntries(
            Object.entries(item).filter(([, value]) => value !== undefined && value !== null && value !== '')
        ) as ThreadsMediaItem;
    }

    private extractTitle(html: string): string {
        const $ = cheerio.load(html);
        return this.cleanText($('title').first().text());
    }

    private parseResultPage(html: string): ThreadsMediaItem[] {
        const $ = cheerio.load(html);
        const tabs = new Map<number, string>();

        $('.download__items_tabs__item').each((_, element) => {
            const index = Number.parseInt($(element).attr('data-index') || '', 10);
            const label = this.cleanText($(element).text());
            if (!Number.isNaN(index) && label) {
                tabs.set(index, label);
            }
        });

        const items: ThreadsMediaItem[] = [];
        $('.download_item').each((_, element) => {
            const $item = $(element);
            const parsedIndex = Number.parseInt($item.attr('data-index') || '', 10);
            const index = Number.isNaN(parsedIndex) ? undefined : parsedIndex;
            const label = index === undefined ? undefined : tabs.get(index);
            const imageSources = $item
                .find('img')
                .toArray()
                .map((img) => $(img).attr('src') || '')
                .filter(Boolean);
            const downloadUrl = $item.find('a.download__item__download_btn').first().attr('href') || undefined;

            items.push(
                this.removeEmpty({
                    index,
                    label,
                    media_type: label ? this.inferMediaType(label) : undefined,
                    username: this.cleanText($item.find('.download__item__profile_pic span').first().text()),
                    caption: this.cleanText($item.find('.download__item__caption__text').first().text()),
                    thumbnail_url: imageSources[0],
                    profile_picture_url: imageSources[1],
                    download_url: downloadUrl,
                    original_media_url: downloadUrl ? this.decodeThreadsterToken(downloadUrl) : undefined
                })
            );
        });

        return items;
    }

    public async download(rawUrl: string): Promise<ThreadsDownloadResult> {
        const sourceUrl = this.normalizeThreadsUrl(rawUrl);
        if (!sourceUrl) {
            throw new AppError('Missing or invalid Threads URL argument.', 400);
        }

        try {
            const homeResponse = await this.fetchWithTimeout(
                THREADSTER_HOME,
                {
                    headers: {
                        'user-agent': USER_AGENT,
                        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
                    }
                },
                DEFAULT_TIMEOUT_MS
            );
            this.assertOk(homeResponse, 'Failed to open Threadster home page');

            const cookie = this.extractCookieHeader(homeResponse);
            const body = new URLSearchParams({ url: sourceUrl });
            const downloadResponse = await this.fetchWithTimeout(
                THREADSTER_DOWNLOAD,
                {
                    method: 'POST',
                    body,
                    headers: {
                        'user-agent': USER_AGENT,
                        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'content-type': 'application/x-www-form-urlencoded',
                        origin: 'https://threadster.app',
                        referer: THREADSTER_HOME,
                        ...(cookie ? { cookie } : {})
                    }
                },
                DEFAULT_TIMEOUT_MS
            );
            this.assertOk(downloadResponse, 'Failed to scrape Threadster download page');

            const html = await downloadResponse.text();
            const items = this.parseResultPage(html);

            if (items.length === 0) {
                const title = this.extractTitle(html) || 'unknown page';
                throw new AppError(
                    `No downloadable media found. The post may be private, deleted, unsupported, or Threadster returned: ${title}`,
                    404
                );
            }

            return {
                source_url: sourceUrl,
                threadster_url: THREADSTER_DOWNLOAD,
                scraped_at: new Date().toISOString(),
                count: items.length,
                items
            };
        } catch (error) {
            if (error instanceof AppError) {
                throw error;
            }

            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Threads Download Error: ${message}`, 500);
        }
    }
}
