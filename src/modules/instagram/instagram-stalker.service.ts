import fs from 'fs';
import dotenv from 'dotenv';
import { Browser, CookieParam, Page } from 'puppeteer-core';
import { launchBrowser } from '../../utils/puppeteer';
import { AppError } from '../../utils/AppError';
import {
    InstagramStalkerAboutAccount,
    InstagramStalkerMediaItem,
    InstagramStalkerOptions,
    InstagramStalkerResult
} from './instagram.types';

dotenv.config({ quiet: true });

const INSTAGRAM_BASE = 'https://www.instagram.com';
const DEFAULT_USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';
const DEFAULT_IG_APP_ID = '936619743392459';
const DEFAULT_ASBD_ID = '129477';

interface ResolvedInstagramStalkerOptions {
    targetUsername: string;
    includePosts: boolean;
    includeReels: boolean;
    includeAbout: boolean;
    maxItems: number | null;
    maxPages: number | null;
    delayMs: number;
    jitterMs: number;
    maxRetries: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    backoffJitterMs: number;
    timeoutMs: number;
    profileOnlyOnRateLimit: boolean;
    warmupDelayMs: number;
    warmupJitterMs: number;
    cookie: string;
    cookieFile: string;
    headful: boolean;
}

interface AuthState {
    method: string;
    viewerUsername: string;
    hasSessionId: boolean;
    cookieFileLoaded: string;
    cookieFileImportedCount: number;
}

interface ApiContext {
    appId: string;
    csrfToken: string;
}

interface AboutDialogResult {
    found: boolean;
    raw_text: string;
    parsed: {
        date_joined: string | null;
        account_based_in: string | null;
        shared_followers_count: string | null;
        verified_since: string | null;
    };
}

interface BrowserCookie {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    secure?: boolean;
    httpOnly?: boolean;
    expires?: number;
}

interface ApiFetchResult {
    ok: boolean;
    status: number;
    text: string;
    json: Record<string, unknown> | null;
    retryAfter: string;
}

class InstagramStalkerError extends Error {
    public readonly isRateLimit: boolean;
    public readonly statusCode: number;

    constructor(message: string, statusCode = 500, isRateLimit = false) {
        super(message);
        this.name = 'InstagramStalkerError';
        this.statusCode = statusCode;
        this.isRateLimit = isRateLimit;
    }
}

const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });

const randomInt = (max: number): number => {
    if (!Number.isFinite(max) || max <= 0) {
        return 0;
    }

    return Math.floor(Math.random() * (Math.floor(max) + 1));
};

const parseRetryAfterMs = (value: string): number => {
    if (!value) {
        return 0;
    }

    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.floor(seconds * 1000);
    }

    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
        return Math.max(0, timestamp - Date.now());
    }

    return 0;
};

const looksLikeRateLimitMessage = (text: unknown): boolean => {
    const value = String(text || '').toLowerCase();
    return (
        value.includes('please wait a few minutes') ||
        value.includes('too many requests') ||
        value.includes('rate limit') ||
        value.includes('feedback_required') ||
        value.includes('temporarily blocked') ||
        value.includes('try again later')
    );
};

const sanitizeMessage = (error: unknown): string => {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof InstagramStalkerError && error.isRateLimit) {
        return 'Rate limited by Instagram (HTTP 429). Wait a few minutes, rotate cookies/session, and try again.';
    }

    if (/HTTP 429/i.test(message) || /Please wait a few minutes/i.test(message)) {
        return 'Rate limited by Instagram. Wait a few minutes, rotate cookies/session, and try again.';
    }

    return message;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const asRecord = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {});

const getString = (object: Record<string, unknown>, key: string): string => {
    const value = object[key];
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
};

const getBoolean = (object: Record<string, unknown>, key: string): boolean => Boolean(object[key]);

const getNumber = (object: Record<string, unknown>, key: string, fallback: number): number => {
    const value = object[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }

    return fallback;
};

const getNullableNumber = (object: Record<string, unknown>, key: string): number | null => {
    const value = object[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }

    return null;
};

const getArray = (object: Record<string, unknown>, key: string): unknown[] =>
    Array.isArray(object[key]) ? object[key] : [];

export class InstagramStalkerService {
    private options: ResolvedInstagramStalkerOptions;
    private browser: Browser | null = null;
    private page: Page | null = null;
    private apiContext: ApiContext = {
        appId: DEFAULT_IG_APP_ID,
        csrfToken: ''
    };
    private auth: AuthState = {
        method: 'none',
        viewerUsername: '',
        hasSessionId: false,
        cookieFileLoaded: '',
        cookieFileImportedCount: 0
    };

    constructor(options: InstagramStalkerOptions) {
        this.options = this.resolveOptions(options);
    }

    public static normalizeTargetUsername(username: string): string {
        return String(username || '').replace(/^@+/, '').trim();
    }

    public static parseCookieHeaderString(cookieHeader: string): BrowserCookie[] {
        const cookies: BrowserCookie[] = [];
        const parts = String(cookieHeader || '').split(';');

        for (const part of parts) {
            const idx = part.indexOf('=');
            if (idx <= 0) {
                continue;
            }

            const name = part.slice(0, idx).trim();
            const value = part.slice(idx + 1).trim();
            if (!name) {
                continue;
            }

            cookies.push({
                name,
                value,
                domain: '.instagram.com',
                path: '/',
                secure: true
            });
        }

        return cookies;
    }

    public static parseNetscapeCookieFile(content: string): BrowserCookie[] {
        const cookies: BrowserCookie[] = [];
        const lines = String(content || '').split(/\r?\n/);

        for (const rawLine of lines) {
            if (!rawLine.trim()) {
                continue;
            }
            if (rawLine.startsWith('#') && !rawLine.startsWith('#HttpOnly_')) {
                continue;
            }

            const parts = rawLine.split('\t');
            if (parts.length < 7) {
                continue;
            }

            let domain = (parts[0] || '').trim();
            const includeSubdomain = (parts[1] || '').trim().toUpperCase() === 'TRUE';
            const path = (parts[2] || '/').trim() || '/';
            const secure = (parts[3] || '').trim().toUpperCase() === 'TRUE';
            const expires = Number(parts[4] || 0);
            const name = (parts[5] || '').trim();
            const value = (parts.slice(6).join('\t') || '').trim();

            if (!name) {
                continue;
            }

            let httpOnly = false;
            if (domain.startsWith('#HttpOnly_')) {
                httpOnly = true;
                domain = domain.slice('#HttpOnly_'.length);
            }

            if (includeSubdomain && domain && !domain.startsWith('.')) {
                domain = `.${domain}`;
            }

            const cookie: BrowserCookie = {
                name,
                value,
                domain: domain || '.instagram.com',
                path,
                secure,
                httpOnly
            };

            if (Number.isFinite(expires) && expires > 0) {
                cookie.expires = Math.floor(expires);
            }

            cookies.push(cookie);
        }

        return cookies;
    }

    public static dedupeCookies(cookies: BrowserCookie[]): BrowserCookie[] {
        const out: BrowserCookie[] = [];
        const seen = new Set<string>();

        for (const cookie of cookies) {
            const domain = cookie.domain || '';
            const path = cookie.path || '/';
            const key = `${cookie.name}|${domain}|${path}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            out.push(cookie);
        }

        return out;
    }

    private resolveOptions(options: InstagramStalkerOptions): ResolvedInstagramStalkerOptions {
        return {
            targetUsername: InstagramStalkerService.normalizeTargetUsername(options.targetUsername),
            includePosts: Boolean(options.includePosts),
            includeReels: Boolean(options.includeReels),
            includeAbout: options.includeAbout !== false,
            maxItems: options.maxItems ?? null,
            maxPages: options.maxPages ?? null,
            delayMs: options.delayMs ?? 2600,
            jitterMs: options.jitterMs ?? 1700,
            maxRetries: options.maxRetries ?? 3,
            backoffBaseMs: options.backoffBaseMs ?? 4000,
            backoffMaxMs: options.backoffMaxMs ?? 120000,
            backoffJitterMs: options.backoffJitterMs ?? 2000,
            timeoutMs: options.timeoutMs ?? 45000,
            profileOnlyOnRateLimit: options.profileOnlyOnRateLimit !== false,
            warmupDelayMs: options.warmupDelayMs ?? 1200,
            warmupJitterMs: options.warmupJitterMs ?? 1000,
            cookie: process.env.INSTAGRAM_COOKIE || '',
            cookieFile: process.env.INSTAGRAM_COOKIE_FILE || '',
            headful: Boolean(options.headful)
        };
    }

    private loadCookiesFromFile(filePath: string): { cookies: BrowserCookie[]; path: string } {
        const fullPath = String(filePath || '').trim();
        if (!fullPath) {
            throw new InstagramStalkerError('Empty cookie file path.', 400);
        }
        if (!fs.existsSync(fullPath)) {
            throw new InstagramStalkerError(`Cookie file not found: ${fullPath}`, 400);
        }

        const content = fs.readFileSync(fullPath, 'utf8');
        const netscape = InstagramStalkerService.parseNetscapeCookieFile(content);
        if (netscape.length > 0) {
            return { cookies: netscape, path: fullPath };
        }

        const headerCookies = InstagramStalkerService.parseCookieHeaderString(content.replace(/\r?\n/g, '; '));
        if (headerCookies.length > 0) {
            return { cookies: headerCookies, path: fullPath };
        }

        throw new InstagramStalkerError(`No cookies parsed from file: ${fullPath}`, 400);
    }

    private computeBackoffMs(attempt: number, retryAfterMs: number): number {
        const maxBackoff = Math.max(0, this.options.backoffMaxMs);
        if (retryAfterMs > 0) {
            return Math.min(retryAfterMs, maxBackoff) + randomInt(this.options.backoffJitterMs);
        }

        const base = Math.max(0, this.options.backoffBaseMs);
        const exponential = base * 2 ** attempt;
        return Math.min(exponential, maxBackoff) + randomInt(this.options.backoffJitterMs);
    }

    private loadCookieSources(): BrowserCookie[] {
        const cookies: BrowserCookie[] = [];

        if (this.options.cookie) {
            const envCookie = this.options.cookie.trim().replace(/^['"]|['"]$/g, '');
            if (fs.existsSync(envCookie)) {
                const loaded = this.loadCookiesFromFile(envCookie);
                cookies.push(...loaded.cookies);
                this.auth.cookieFileLoaded = loaded.path;
                this.auth.cookieFileImportedCount = loaded.cookies.length;
            } else {
                cookies.push(...InstagramStalkerService.parseCookieHeaderString(envCookie));
            }
        }

        if (this.options.cookieFile) {
            const loaded = this.loadCookiesFromFile(this.options.cookieFile);
            cookies.push(...loaded.cookies);
            this.auth.cookieFileLoaded = loaded.path;
            this.auth.cookieFileImportedCount = loaded.cookies.length;
        }

        if (this.options.cookie && cookies.length === 0) {
            throw new InstagramStalkerError(
                'INSTAGRAM_COOKIE must be a cookie header or an existing cookie file path.',
                400
            );
        }

        return InstagramStalkerService.dedupeCookies(cookies);
    }

    private formatHttpError(status: number, bodyText: string, jsonData: Record<string, unknown> | null): string {
        const message = jsonData && typeof jsonData.message === 'string' ? jsonData.message : '';
        if (message) {
            return `HTTP ${status}: ${message}`;
        }

        const shortBody = String(bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 220);
        return `HTTP ${status}: ${shortBody || 'Unknown error'}`;
    }

    private async launchBrowser(): Promise<void> {
        this.browser = await launchBrowser({
            headless: this.options.headful ? false : true,
            defaultViewport: { width: 1366, height: 768 }
        });
        this.page = await this.browser.newPage();
        this.page.setDefaultTimeout(this.options.timeoutMs);
        await this.page.setUserAgent(DEFAULT_USER_AGENT);
        await this.page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9'
        });
    }

    private assertPage(): Page {
        if (!this.page) {
            throw new InstagramStalkerError('Browser page is not initialized.');
        }

        return this.page;
    }

    private async setCookiesOnPage(cookies: BrowserCookie[]): Promise<void> {
        if (!Array.isArray(cookies) || cookies.length === 0) {
            return;
        }

        const normalized = cookies
            .filter((cookie) => Boolean(cookie && cookie.name))
            .map((cookie) => {
                const out: CookieParam = {
                    name: String(cookie.name),
                    value: String(cookie.value || ''),
                    domain: cookie.domain || '.instagram.com',
                    path: cookie.path || '/',
                    secure: Boolean(cookie.secure),
                    httpOnly: Boolean(cookie.httpOnly)
                };

                if (Number.isFinite(cookie.expires) && Number(cookie.expires) > 0) {
                    out.expires = Math.floor(Number(cookie.expires));
                }

                return out;
            });

        if (normalized.length > 0) {
            await this.assertPage().setCookie(...normalized);
        }
    }

    private async verifySession(message = 'Failed to authenticate on Instagram. Session cookie is missing.'): Promise<void> {
        const browserCookies = await this.assertPage().cookies(`${INSTAGRAM_BASE}/`);
        const sessionCookie = browserCookies.find((cookie) => cookie.name === 'sessionid');

        if (!sessionCookie || !sessionCookie.value) {
            throw new InstagramStalkerError(message, 401);
        }

        this.auth.hasSessionId = true;
        if (this.auth.method === 'none') {
            this.auth.method = this.auth.cookieFileLoaded ? 'cookie_file_session' : 'cookie_session';
        }
    }

    private async readAppId(): Promise<void> {
        const appId = (await this.assertPage().evaluate((fallbackAppId) => {
            const html = document.documentElement ? document.documentElement.innerHTML : '';
            const match = html.match(/"X-IG-App-ID":"(\d+)"/i) || html.match(/"appId":"(\d+)"/i);
            return match ? match[1] : fallbackAppId;
        }, DEFAULT_IG_APP_ID)) as string;
        this.apiContext.appId = appId || DEFAULT_IG_APP_ID;
    }

    private async readCsrfToken(): Promise<void> {
        const csrfToken = (await this.assertPage().evaluate(() => {
            const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/);
            return match ? decodeURIComponent(match[1]) : '';
        })) as string;
        this.apiContext.csrfToken = csrfToken || '';
    }

    private async fetchApiJson(endpointPath: string): Promise<Record<string, unknown>> {
        const endpoint = endpointPath.startsWith('http') ? endpointPath : `${INSTAGRAM_BASE}${endpointPath}`;

        for (let attempt = 0; attempt <= this.options.maxRetries; attempt += 1) {
            if (attempt > 0) {
                const waitMs = this.computeBackoffMs(attempt - 1, 0);
                await sleep(waitMs);
            }

            const result = (await this.assertPage().evaluate(
                async (payload) => {
                    try {
                        const headers: Record<string, string> = {
                            Accept: '*/*',
                            'X-IG-App-ID': payload.appId,
                            'X-ASBD-ID': payload.asbdId,
                            'X-Requested-With': 'XMLHttpRequest'
                        };
                        if (payload.csrfToken) {
                            headers['X-CSRFToken'] = payload.csrfToken;
                        }

                        const response = await fetch(payload.url, {
                            method: 'GET',
                            headers,
                            credentials: 'include',
                            mode: 'same-origin'
                        });

                        const text = await response.text();
                        let json: Record<string, unknown> | null = null;
                        try {
                            json = JSON.parse(text) as Record<string, unknown>;
                        } catch {
                            json = null;
                        }

                        return {
                            ok: response.ok,
                            status: response.status,
                            text,
                            json,
                            retryAfter: response.headers.get('retry-after') || ''
                        };
                    } catch (error) {
                        return {
                            ok: false,
                            status: 0,
                            text: error instanceof Error ? error.message : String(error),
                            json: null,
                            retryAfter: ''
                        };
                    }
                },
                {
                    url: endpoint,
                    appId: this.apiContext.appId,
                    asbdId: DEFAULT_ASBD_ID,
                    csrfToken: this.apiContext.csrfToken
                }
            )) as ApiFetchResult;

            const status = Number(result.status || 0);
            const jsonMessage = result.json && typeof result.json.message === 'string' ? result.json.message : '';
            const rateLimitSignal =
                status === 429 || looksLikeRateLimitMessage(result.text) || looksLikeRateLimitMessage(jsonMessage);

            if (rateLimitSignal) {
                if (attempt < this.options.maxRetries) {
                    const retryMs = parseRetryAfterMs(result.retryAfter);
                    const backoffMs = this.computeBackoffMs(attempt, retryMs);
                    await sleep(backoffMs);
                    continue;
                }

                throw new InstagramStalkerError(this.formatHttpError(status || 429, result.text, result.json), 429, true);
            }

            if (status === 0 || (status >= 500 && status <= 599)) {
                if (attempt < this.options.maxRetries) {
                    const retryMs = parseRetryAfterMs(result.retryAfter);
                    const backoffMs = this.computeBackoffMs(attempt, retryMs);
                    await sleep(backoffMs);
                    continue;
                }
            }

            if (!result.ok) {
                throw new InstagramStalkerError(this.formatHttpError(status, result.text, result.json), status || 500);
            }

            if (!result.json) {
                throw new InstagramStalkerError(`Invalid JSON response from ${endpointPath}`);
            }

            if (result.json.status && result.json.status !== 'ok' && result.json.status !== 'success') {
                const msg = typeof result.json.message === 'string' ? result.json.message : JSON.stringify(result.json);
                if (looksLikeRateLimitMessage(msg)) {
                    throw new InstagramStalkerError(`Instagram API error: ${msg}`, 429, true);
                }
                throw new InstagramStalkerError(`Instagram API error: ${msg}`);
            }

            return result.json;
        }

        throw new InstagramStalkerError(`Failed to fetch ${endpointPath}`);
    }

    private async fetchProfileInfo(): Promise<Record<string, unknown>> {
        const path = `/api/v1/users/web_profile_info/?username=${encodeURIComponent(this.options.targetUsername)}`;
        const data = await this.fetchApiJson(path);
        const user = asRecord(asRecord(data.data).user);

        if (Object.keys(user).length === 0) {
            throw new InstagramStalkerError('Target profile not found or unavailable.', 404);
        }

        return user;
    }

    private async fetchUserInfo(userId: string): Promise<Record<string, unknown>> {
        const path = `/api/v1/users/${encodeURIComponent(userId)}/info/`;
        const data = await this.fetchApiJson(path);
        return asRecord(data.user);
    }

    private normalizeCaption(captionObj: unknown): string {
        const caption = asRecord(captionObj);
        return getString(caption, 'text');
    }

    private getImageUrl(media: Record<string, unknown>): string {
        const imageVersions = asRecord(media.image_versions2);
        const candidates = getArray(imageVersions, 'candidates').map((item) => asRecord(item));
        return candidates.length > 0 ? getString(candidates[0], 'url') : '';
    }

    private getVideoUrl(media: Record<string, unknown>): string {
        const versions = getArray(media, 'video_versions').map((item) => asRecord(item));
        return versions.length > 0 ? getString(versions[0], 'url') : '';
    }

    private mapCarouselMedia(node: Record<string, unknown>): InstagramStalkerMediaItem['carousel_media'] {
        return getArray(node, 'carousel_media').map((rawItem) => {
            const item = asRecord(rawItem);
            const mediaType = getNumber(item, 'media_type', 0);
            return {
                id: getString(item, 'id'),
                media_type: mediaType,
                is_video: mediaType === 2,
                image_url: this.getImageUrl(item),
                video_url: mediaType === 2 ? this.getVideoUrl(item) : ''
            };
        });
    }

    private mapMediaItem(rawItem: unknown): InstagramStalkerMediaItem {
        const item = asRecord(rawItem);
        const shortcode = getString(item, 'code');
        const productType = getString(item, 'product_type');
        const mediaType = getNumber(item, 'media_type', 0);
        const isReel = productType === 'clips';
        const permalink = shortcode
            ? isReel
                ? `${INSTAGRAM_BASE}/reel/${shortcode}/`
                : `${INSTAGRAM_BASE}/p/${shortcode}/`
            : '';
        const caption = this.normalizeCaption(item.caption);
        const takenAt = getNumber(item, 'taken_at', 0);

        return {
            id: getString(item, 'id'),
            pk: getString(item, 'pk'),
            shortcode,
            permalink,
            product_type: productType,
            media_type: mediaType,
            is_video: mediaType === 2,
            is_reel: isReel,
            taken_at_utc: takenAt ? new Date(takenAt * 1000).toISOString() : '',
            like_count: getNumber(item, 'like_count', 0),
            comment_count: getNumber(item, 'comment_count', 0),
            play_count: getNullableNumber(item, 'play_count'),
            view_count: getNullableNumber(item, 'view_count'),
            caption,
            caption_preview: caption.slice(0, 200),
            thumbnail_url: this.getImageUrl(item),
            video_url: mediaType === 2 ? this.getVideoUrl(item) : '',
            carousel_media: this.mapCarouselMedia(item)
        };
    }

    private async fetchAllMedia(userId: string): Promise<InstagramStalkerMediaItem[]> {
        const out: InstagramStalkerMediaItem[] = [];
        let maxId = '';
        let pageCount = 0;

        while (true) {
            if (this.options.maxPages !== null && pageCount >= this.options.maxPages) {
                break;
            }

            const qs = new URLSearchParams();
            qs.set('count', '12');
            if (maxId) {
                qs.set('max_id', maxId);
            }

            const path = `/api/v1/feed/user/${encodeURIComponent(userId)}/?${qs.toString()}`;
            const data = await this.fetchApiJson(path);
            const items = getArray(data, 'items');

            for (const item of items) {
                out.push(this.mapMediaItem(item));
                if (this.options.maxItems !== null && out.length >= this.options.maxItems) {
                    break;
                }
            }

            if (this.options.maxItems !== null && out.length >= this.options.maxItems) {
                break;
            }

            const hasMore = Boolean(data.more_available);
            const nextMaxId = typeof data.next_max_id === 'string' ? data.next_max_id : '';
            pageCount += 1;

            if (!hasMore || !nextMaxId) {
                break;
            }

            maxId = nextMaxId;
            const waitMs = this.options.delayMs + randomInt(this.options.jitterMs);
            if (waitMs > 0) {
                await sleep(waitMs);
            }
        }

        return out;
    }

    private parseAboutDialogText(text: string): AboutDialogResult['parsed'] {
        const lines = String(text || '')
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean);

        const hasMonthYear = (value: string) =>
            /(januari|februari|maret|april|mei|juni|juli|agustus|september|oktober|november|desember|january|february|march|april|may|june|july|august|september|october|november|december)/i.test(
                value
            ) && /\b(19|20)\d{2}\b/.test(value);

        const pickValueAfter = (matchers: string[]): string | null => {
            for (let i = 0; i < lines.length; i += 1) {
                const lower = lines[i].toLowerCase();
                if (matchers.some((matcher) => lower.includes(matcher)) && i + 1 < lines.length) {
                    return lines[i + 1];
                }
            }
            return null;
        };

        const pickNumberInlineOrAfter = (matchers: string[]): string | null => {
            for (let i = 0; i < lines.length; i += 1) {
                const lower = lines[i].toLowerCase();
                if (!matchers.some((matcher) => lower.includes(matcher))) {
                    continue;
                }

                const inline = lines[i].match(/\b\d{1,3}(?:[.,]\d{3})*\b/);
                if (inline) {
                    return inline[0];
                }

                if (i + 1 < lines.length) {
                    const next = lines[i + 1].match(/\b\d{1,3}(?:[.,]\d{3})*\b/);
                    if (next) {
                        return next[0];
                    }
                }
            }
            return null;
        };

        const pickVerifiedSince = (): string | null => {
            for (let i = 0; i < lines.length; i += 1) {
                const lower = lines[i].toLowerCase();
                if (!(lower.includes('verified') || lower.includes('terverifikasi'))) {
                    continue;
                }
                if (i + 1 < lines.length && hasMonthYear(lines[i + 1])) {
                    return lines[i + 1];
                }
            }
            return null;
        };

        return {
            date_joined: pickValueAfter(['date joined', 'tanggal bergabung']),
            account_based_in: pickValueAfter(['account based in', 'akun berlokasi di']),
            shared_followers_count: pickNumberInlineOrAfter([
                'accounts with shared followers',
                'akun dengan pengikut yang sama'
            ]),
            verified_since: pickVerifiedSince()
        };
    }

    private emptyAboutDialog(): AboutDialogResult {
        return {
            found: false,
            raw_text: '',
            parsed: {
                date_joined: null,
                account_based_in: null,
                shared_followers_count: null,
                verified_since: null
            }
        };
    }

    private async readAboutDialogFromPage(): Promise<AboutDialogResult> {
        if (!this.options.includeAbout) {
            return this.emptyAboutDialog();
        }

        try {
            const data = (await this.assertPage().evaluate(async (targetUsername) => {
                const wait = (ms: number) =>
                    new Promise<void>((resolve) => {
                        setTimeout(resolve, ms);
                    });

                const byTextContains = (list: string[]): Element | null => {
                    const needleList = list.map((x) => String(x).toLowerCase()).filter(Boolean);
                    if (needleList.length === 0) {
                        return null;
                    }

                    const candidates = Array.from(document.querySelectorAll('button, a, div, span, h1, h2'));
                    let best: Element | null = null;

                    for (const el of candidates) {
                        const text = (el.textContent || el.getAttribute('aria-label') || '').trim();
                        if (!text) {
                            continue;
                        }
                        const lower = text.toLowerCase();
                        if (!needleList.some((needle) => lower === needle || lower.includes(needle))) {
                            continue;
                        }

                        const rect = el.getBoundingClientRect();
                        if (!rect || rect.width <= 0 || rect.height <= 0) {
                            continue;
                        }

                        best = el;
                        if (lower === targetUsername.toLowerCase()) {
                            break;
                        }
                    }

                    return best;
                };

                const clickIfExists = (keywords: string[]): boolean => {
                    const el = byTextContains(keywords);
                    if (!el) {
                        return false;
                    }

                    try {
                        el.dispatchEvent(
                            new MouseEvent('click', {
                                bubbles: true,
                                cancelable: true,
                                view: window
                            })
                        );
                        return true;
                    } catch {
                        return false;
                    }
                };

                clickIfExists(['options', 'opsi', 'menu']);
                await wait(800);
                clickIfExists(['about this account', 'tentang akun ini']);
                await wait(800);
                clickIfExists([targetUsername]);
                await wait(800);
                clickIfExists(['about this account', 'tentang akun ini']);
                await wait(1200);

                let text = '';
                const nodes = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], section, article'));
                const aboutSignals =
                    /(about this account|tentang akun ini|date joined|tanggal bergabung|account based in|akun berlokasi di|accounts with shared followers|akun dengan pengikut yang sama)/i;
                for (const node of nodes) {
                    const value = ('innerText' in node ? String(node.innerText || '') : '').trim();
                    if (!value || !aboutSignals.test(value)) {
                        continue;
                    }
                    if (value.length > text.length) {
                        text = value;
                    }
                }

                return {
                    found: Boolean(text),
                    rawText: text
                };
            }, this.options.targetUsername)) as { found?: boolean; rawText?: string } | null;

            if (!data || !data.found || !data.rawText) {
                return this.emptyAboutDialog();
            }

            return {
                found: true,
                raw_text: data.rawText,
                parsed: this.parseAboutDialogText(data.rawText)
            };
        } catch {
            return this.emptyAboutDialog();
        }
    }

    private buildAboutAccount(
        profileUser: Record<string, unknown>,
        infoUser: Record<string, unknown>,
        dialogAbout: AboutDialogResult
    ): InstagramStalkerAboutAccount {
        const parsedDialog = dialogAbout.parsed;
        const sharedFollowersFromDialog = parsedDialog.shared_followers_count
            ? Number(String(parsedDialog.shared_followers_count).replace(/[.,]/g, ''))
            : null;

        const sharedFollowersCount =
            Number.isFinite(sharedFollowersFromDialog) && Number(sharedFollowersFromDialog) >= 0
                ? Number(sharedFollowersFromDialog)
                : getNullableNumber(infoUser, 'mutual_followers_count');

        return {
            available: Boolean(profileUser.show_account_transparency_details || infoUser.show_account_transparency_details),
            date_joined: parsedDialog.date_joined || null,
            account_based_in: parsedDialog.account_based_in || null,
            shared_followers_count: sharedFollowersCount,
            verified_since: parsedDialog.verified_since || null,
            is_verified: getBoolean(profileUser, 'is_verified'),
            show_account_transparency_details: Boolean(
                infoUser.show_account_transparency_details || profileUser.show_account_transparency_details
            ),
            transparency_product_enabled: Boolean(
                infoUser.transparency_product_enabled || profileUser.transparency_product_enabled
            ),
            transparency_label: getString(infoUser, 'transparency_label') || getString(profileUser, 'transparency_label') || null,
            mutual_followers_count: getNullableNumber(infoUser, 'mutual_followers_count'),
            profile_context_mutual_follow_ids: getArray(infoUser, 'profile_context_mutual_follow_ids').map(String),
            source: {
                users_info_endpoint: true,
                about_dialog_scrape: Boolean(dialogAbout && dialogAbout.found)
            }
        };
    }

    private buildResultProfile(profileUser: Record<string, unknown>): InstagramStalkerResult['profile'] {
        return {
            id: getString(profileUser, 'id'),
            username: getString(profileUser, 'username'),
            full_name: getString(profileUser, 'full_name'),
            biography: getString(profileUser, 'biography'),
            external_url: getString(profileUser, 'external_url'),
            is_private: getBoolean(profileUser, 'is_private'),
            is_verified: getBoolean(profileUser, 'is_verified'),
            is_business_account: getBoolean(profileUser, 'is_business_account'),
            followers_count: getNumber(asRecord(profileUser.edge_followed_by), 'count', 0),
            following_count: getNumber(asRecord(profileUser.edge_follow), 'count', 0),
            posts_count: getNumber(asRecord(profileUser.edge_owner_to_timeline_media), 'count', 0),
            profile_pic_url: getString(profileUser, 'profile_pic_url_hd') || getString(profileUser, 'profile_pic_url')
        };
    }

    private toAppError(error: unknown): AppError {
        if (error instanceof AppError) {
            return error;
        }

        if (error instanceof InstagramStalkerError) {
            return new AppError(sanitizeMessage(error), error.statusCode);
        }

        const message = error instanceof Error ? error.message : 'Unknown error';
        return new AppError(`Instagram Stalker Error: ${message}`, 500);
    }

    public async run(): Promise<InstagramStalkerResult> {
        if (!this.options.targetUsername) {
            throw new AppError('Username is required', 400);
        }

        try {
            const cookies = this.loadCookieSources();
            if (cookies.length === 0) {
                throw new InstagramStalkerError(
                    'Authentication required. Set INSTAGRAM_COOKIE or INSTAGRAM_COOKIE_FILE in .env.',
                    400
                );
            }

            const warnings: string[] = [];

            await this.launchBrowser();
            const page = this.assertPage();

            await this.setCookiesOnPage(cookies);
            await this.verifySession(
                'Instagram session cookie was not imported into the browser. Check INSTAGRAM_COOKIE_FILE format.'
            );

            await page.goto(`${INSTAGRAM_BASE}/${this.options.targetUsername}/`, {
                waitUntil: 'domcontentloaded',
                timeout: this.options.timeoutMs
            });

            const warmupMs = this.options.warmupDelayMs + randomInt(this.options.warmupJitterMs);
            if (warmupMs > 0) {
                await sleep(warmupMs);
            }

            await this.verifySession(
                'Instagram rejected the imported session cookie and redirected to login. Export fresh cookies from a currently logged-in Instagram session, then restart the server.'
            );
            await this.readAppId();
            await this.readCsrfToken();

            const profileUser = await this.fetchProfileInfo();
            const infoUser = await this.fetchUserInfo(getString(profileUser, 'id'));
            const aboutDialog = await this.readAboutDialogFromPage();
            const aboutAccount = this.buildAboutAccount(profileUser, infoUser, aboutDialog);

            let allMedia: InstagramStalkerMediaItem[] = [];
            if (this.options.includePosts || this.options.includeReels) {
                try {
                    allMedia = await this.fetchAllMedia(getString(profileUser, 'id'));
                } catch (error) {
                    if (
                        this.options.profileOnlyOnRateLimit &&
                        error instanceof InstagramStalkerError &&
                        error.isRateLimit
                    ) {
                        warnings.push(
                            'Media pagination hit Instagram rate limit. Returning profile/about data only; try again later for full posts/reels.'
                        );
                    } else {
                        throw error;
                    }
                }
            }

            const reels = allMedia.filter((item) => item.is_reel);
            const posts = allMedia.filter((item) => !item.is_reel);

            const result: InstagramStalkerResult = {
                status: 'ok',
                include: {
                    about_account: this.options.includeAbout,
                    posts: this.options.includePosts,
                    reels: this.options.includeReels
                },
                auth: {
                    method: this.auth.method,
                    viewer_username: this.auth.viewerUsername,
                    has_sessionid: this.auth.hasSessionId,
                    cookie_file_loaded: this.auth.cookieFileLoaded,
                    cookie_file_imported_count: this.auth.cookieFileImportedCount
                },
                target_username: getString(profileUser, 'username'),
                profile: this.buildResultProfile(profileUser),
                warnings
            };

            if (this.options.includeAbout) {
                result.about_account = aboutAccount;
            }

            if (this.options.includePosts) {
                result.posts_count = posts.length;
                result.posts = posts;
            }

            if (this.options.includeReels) {
                result.reels_count = reels.length;
                result.reels = reels;
            }

            if (this.options.includePosts || this.options.includeReels) {
                result.all_posts_count = allMedia.length;
            }

            return result;
        } catch (error) {
            throw this.toAppError(error);
        } finally {
            if (this.browser) {
                await this.browser.close();
            }
        }
    }
}
