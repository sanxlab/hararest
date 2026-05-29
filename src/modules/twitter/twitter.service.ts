import * as cheerio from 'cheerio';
import { AppError } from '../../utils/AppError';
import { TwitterDownloadResult, TwitterMediaLink } from './twitter.types';

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

const cloudscraper = require('cloudscraper') as CloudscraperClient;

const BASE_URL = 'https://twittervideodownloader.com';
const LANDING_URL = `${BASE_URL}/en/`;
const DOWNLOAD_URL = `${BASE_URL}/download`;

const DEFAULT_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

export class TwitterService {
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

    private parseHiddenInputs(htmlText: string): { csrfToken: string; gqlToken: string } {
        const $ = cheerio.load(htmlText);
        const csrfToken = ($('input[name="csrfmiddlewaretoken"]').attr('value') || '').trim();
        const gqlToken = ($('input[name="gql"]').attr('value') || '').trim();
        return { csrfToken, gqlToken };
    }

    private extractErrors(htmlText: string): string[] {
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

        $('a.tw-btn[href]').each((_, element) => {
            const href = ($(element).attr('href') || '').trim();
            if (!href.startsWith('http')) {
                return;
            }

            mediaLinks.push({
                label: $(element).text().replace(/\s+/g, ' ').trim(),
                quality: (($(element).attr('data-filename') || '').replace(': mp4', '') || '').trim(),
                url: href
            });
        });

        return mediaLinks;
    }

    private toHTML(payload: unknown): string {
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

            const landingHtml = this.toHTML(landingResponse);
            const { csrfToken, gqlToken } = this.parseHiddenInputs(landingHtml);

            if (!csrfToken || !gqlToken) {
                throw new AppError('Failed to read required form tokens from landing page.', 500);
            }

            const resultResponse = await cloudscraper.post({
                uri: DOWNLOAD_URL,
                headers: {
                    ...DEFAULT_HEADERS,
                    Origin: BASE_URL,
                    Referer: LANDING_URL,
                    'X-Requested-With': 'XMLHttpRequest'
                },
                form: {
                    csrfmiddlewaretoken: csrfToken,
                    tweet: tweetUrl,
                    gql: gqlToken
                },
                jar,
                timeout: 45000
            });

            const resultHtml = this.toHTML(resultResponse);
            if (resultHtml.toLowerCase().includes('just a moment')) {
                throw new AppError('Blocked by Cloudflare challenge while scraping.', 503);
            }

            const mediaLinks = this.extractMediaLinks(resultHtml);
            if (mediaLinks.length === 0) {
                const errors = this.extractErrors(resultHtml);
                if (errors.length > 0) {
                    throw new AppError(errors.join(' | '), 404);
                }

                throw new AppError('No downloadable media links found in result.', 404);
            }

            return {
                status: 'ok',
                input_url: tweetUrl,
                downloader_url: DOWNLOAD_URL,
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
