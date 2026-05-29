import * as cheerio from 'cheerio';
import { AppError } from '../../utils/AppError';
import { TwitterDownloadResult, TwitterMediaLink, TwitterMediaType } from './twitter.types';

interface CloudscraperRequestOptions {
    uri: string;
    headers: Record<string, string>;
    jar?: unknown;
    timeout?: number;
    form?: Record<string, string>;
}

interface CloudscraperClient {
    jar: () => unknown;
    get: (options: CloudscraperRequestOptions) => Promise<unknown>;
    post: (options: CloudscraperRequestOptions) => Promise<unknown>;
}

interface SaveTwitterResponse {
    status?: string;
    data?: unknown;
    msg?: unknown;
}

const cloudscraper = require('cloudscraper') as CloudscraperClient;

const BASE_URL = 'https://savetwitter.net';
const LANDING_URL = `${BASE_URL}/en4`;
const DEFAULT_SEARCH_URL = `${BASE_URL}/api/ajaxSearch`;

const DEFAULT_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

export class TwitterService {
    private extractVar(htmlText: string, name: string, defaultValue: string): string {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`${escaped}\\s*=\\s*['"]([^'"]+)['"]`);
        const match = htmlText.match(regex);
        return match ? match[1] : defaultValue;
    }

    private parsePageConfig(htmlText: string): { searchUrl: string; lang: string } {
        return {
            searchUrl: this.extractVar(htmlText, 'k_url_search', DEFAULT_SEARCH_URL),
            lang: this.extractVar(htmlText, 'k_lang', 'en')
        };
    }

    private normalizeTweetUrl(rawUrl: string): string {
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
            const isTwitterHost =
                hostname === 'twitter.com' ||
                hostname.endsWith('.twitter.com') ||
                hostname === 'x.com' ||
                hostname.endsWith('.x.com');

            if (!isTwitterHost) {
                return '';
            }

            return parsed.toString();
        } catch {
            return '';
        }
    }

    private stripTags(text: string): string {
        const $ = cheerio.load(`<div>${text || ''}</div>`);
        return $('div').text().replace(/\s+/g, ' ').trim();
    }

    private extractErrors(htmlText: string, responseMessage: string): string[] {
        if (responseMessage) {
            return [this.stripTags(responseMessage)];
        }

        const $ = cheerio.load(htmlText);
        const messages: string[] = [];

        $('.alert, .error, .text-danger').each((_, element) => {
            const text = $(element).text().replace(/\s+/g, ' ').trim();
            if (text) {
                messages.push(text);
            }
        });

        return messages;
    }

    private extractMediaLinks(htmlText: string): TwitterMediaLink[] {
        const $ = cheerio.load(htmlText);
        const mediaLinks: TwitterMediaLink[] = [];
        const seenUrls = new Set<string>();

        $('a[href]').each((_, element) => {
            const href = ($(element).attr('href') || '').trim().replace(/&amp;/g, '&');
            if (!href.startsWith('http')) {
                return;
            }

            const label = $(element).text().replace(/\s+/g, ' ').trim();
            const title = ($(element).attr('title') || '').trim();
            const fingerprint = `${label} ${title} ${href}`.toLowerCase();

            const looksLikeDownloadText = /(download|mp4|mp3|gif|photo|image)/i.test(label)
                || /(download|mp4|mp3|gif|photo|image)/i.test(title);
            const looksLikeMediaUrl =
                /dl\.snapcdn\.app\/get\?token=|video\.twimg\.com|pbs\.twimg\.com|\.mp4(\?|$)|\.mp3(\?|$)|\.(jpg|jpeg|png|webp)(\?|$)/i.test(
                    href
                );

            if (!(looksLikeDownloadText || looksLikeMediaUrl)) {
                return;
            }

            if (seenUrls.has(href)) {
                return;
            }
            seenUrls.add(href);

            let mediaType: TwitterMediaType = 'video';
            if (/mp3|audio/.test(fingerprint)) {
                mediaType = 'audio';
            } else if (/photo|image|jpg|jpeg|png|webp/.test(fingerprint)) {
                mediaType = 'image';
            }

            const qualityMatch = label.match(/\(([^)]+)\)/);
            mediaLinks.push({
                label,
                quality: qualityMatch ? qualityMatch[1].trim() : '',
                media_type: mediaType,
                url: href
            });
        });

        return mediaLinks;
    }

    private toText(payload: unknown): string {
        if (typeof payload === 'string') {
            return payload;
        }

        if (Buffer.isBuffer(payload)) {
            return payload.toString('utf-8');
        }

        return String(payload || '');
    }

    public async download(rawUrl: string): Promise<TwitterDownloadResult> {
        const tweetUrl = this.normalizeTweetUrl(rawUrl);
        if (!tweetUrl) {
            throw new AppError('Missing or invalid X/Twitter URL argument.', 400);
        }

        try {
            const jar = cloudscraper.jar();

            const landingResponse = await cloudscraper.get({
                uri: LANDING_URL,
                headers: DEFAULT_HEADERS,
                jar,
                timeout: 30000
            });

            const landingHtml = this.toText(landingResponse);
            const pageConfig = this.parsePageConfig(landingHtml);
            const $ = cheerio.load(landingHtml);
            const cftoken = ($('input[name="cf-turnstile-response"]').attr('value') || '').trim();

            const resultResponse = await cloudscraper.post({
                uri: pageConfig.searchUrl,
                headers: {
                    ...DEFAULT_HEADERS,
                    Origin: BASE_URL,
                    Referer: LANDING_URL,
                    'X-Requested-With': 'XMLHttpRequest'
                },
                form: {
                    q: tweetUrl,
                    lang: pageConfig.lang,
                    cftoken
                },
                jar,
                timeout: 45000
            });

            const resultBody = this.toText(resultResponse);
            if (resultBody.toLowerCase().includes('just a moment')) {
                throw new AppError('Blocked by Cloudflare challenge while scraping.', 503);
            }

            let data: SaveTwitterResponse;
            try {
                data = JSON.parse(resultBody) as SaveTwitterResponse;
            } catch {
                throw new AppError('SaveTwitter response is not valid JSON.', 500);
            }

            if (data.status !== 'ok') {
                throw new AppError(`Unexpected status: ${data.status || 'unknown'}`, 500);
            }

            const resultHtml = typeof data.data === 'string' ? data.data : '';
            const responseMessage = typeof data.msg === 'string' ? data.msg : '';
            const mediaLinks = this.extractMediaLinks(resultHtml);

            if (mediaLinks.length === 0) {
                const errors = this.extractErrors(resultHtml, responseMessage);
                if (errors.length > 0) {
                    throw new AppError(errors.join(' | '), 404);
                }

                throw new AppError('No downloadable media links found in result.', 404);
            }

            return {
                status: 'ok',
                input_url: tweetUrl,
                search_url: pageConfig.searchUrl,
                media_links: mediaLinks
            };
        } catch (error) {
            if (error instanceof AppError) {
                throw error;
            }

            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Twitter Download Error: ${message}`, 500);
        }
    }
}
