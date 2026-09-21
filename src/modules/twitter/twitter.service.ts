import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import { AppError } from '../../utils/AppError';
import { publicHttpAgent, publicHttpsAgent } from '../../utils/publicAgent';
import { TwitterDownloadResult, TwitterMediaLink, TwitterMediaType } from './twitter.types';

interface SaveTwitterResponse {
    status?: string;
    data?: unknown;
    msg?: unknown;
}

const BASE_URL = 'https://savetwitter.net';
const LANDING_URL = `${BASE_URL}/en4`;
const DEFAULT_SEARCH_URL = `${BASE_URL}/api/ajaxSearch`;

const DEFAULT_HEADERS = {
    'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
};

export class TwitterService {
    // Keep cookies isolated to one download, and validate every redirect before
    // sending cookies or tweet data. The socket agent also checks DNS addresses.
    private async requestPage(target: string, jar: CookieJar, form?: URLSearchParams): Promise<string> {
        for (let hop = 0; hop <= 3; hop++) {
            const url = new URL(target);
            if (url.origin !== BASE_URL || url.username || url.password) {
                throw new AppError('SaveTwitter returned an invalid endpoint.', 502);
            }
            const response = await axios.request<string>({
                url: url.href,
                method: form ? 'POST' : 'GET',
                data: form?.toString(),
                responseType: 'text',
                timeout: form ? 45000 : 30000,
                maxContentLength: 5 * 1024 * 1024,
                maxBodyLength: 16 * 1024,
                maxRedirects: 0,
                proxy: false,
                httpAgent: publicHttpAgent,
                httpsAgent: publicHttpsAgent,
                headers: {
                    ...DEFAULT_HEADERS,
                    Cookie: await jar.getCookieString(url.href),
                    ...(form ? {
                        Origin: BASE_URL,
                        Referer: LANDING_URL,
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'X-Requested-With': 'XMLHttpRequest',
                    } : {}),
                },
                validateStatus: status => (status >= 200 && status < 300)
                    || [301, 302, 303, 307, 308].includes(status),
            });
            for (const cookie of response.headers['set-cookie'] ?? []) {
                await jar.setCookie(cookie, url.href, { ignoreError: true });
            }
            if (response.status >= 200 && response.status < 300) return this.toText(response.data);
            // A redirected POST is not a search result; never replay user data.
            if (form || typeof response.headers.location !== 'string') {
                throw new AppError('SaveTwitter returned an unexpected redirect.', 502);
            }
            target = new URL(response.headers.location, url).href;
        }
        throw new AppError('Too many SaveTwitter redirects.', 502);
    }

    private extractVar(htmlText: string, name: string, defaultValue: string): string {
        const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp(`${escaped}\\s*=\\s*['"]([^'"]+)['"]`);
        const match = htmlText.match(regex);
        return match ? match[1] : defaultValue;
    }

    private parsePageConfig(htmlText: string): { searchUrl: string; lang: string } {
        const searchUrl = new URL(this.extractVar(htmlText, 'k_url_search', DEFAULT_SEARCH_URL), BASE_URL);
        if (searchUrl.origin !== BASE_URL || searchUrl.username || searchUrl.password)
            throw new AppError('SaveTwitter returned an invalid search endpoint.', 502);
        return {
            searchUrl: searchUrl.toString(),
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
            if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.port) {
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
            const jar = new CookieJar();
            const landingHtml = await this.requestPage(LANDING_URL, jar);
            if (/just a moment|cf-chl-/i.test(landingHtml)) {
                throw new AppError('Blocked by Cloudflare challenge while scraping.', 503);
            }
            const pageConfig = this.parsePageConfig(landingHtml);
            const $ = cheerio.load(landingHtml);
            const cftoken = ($('input[name="cf-turnstile-response"]').attr('value') || '').trim();

            const resultBody = await this.requestPage(pageConfig.searchUrl, jar, new URLSearchParams({
                q: tweetUrl,
                lang: pageConfig.lang,
                cftoken,
            }));
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

            throw new AppError('Unable to contact the Twitter download provider. Try again later.', 502);
        }
    }
}
