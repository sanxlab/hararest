import { getPublicPage } from '../../utils/http';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { AppError } from '../../utils/AppError';
import { publicHttpAgent, publicHttpsAgent } from '../../utils/publicAgent';
import { PinterestDownload, PinterestSearchResponse, PinterestSearchItem, PinterestUserResponse } from './pinterest.types';

type JsonObject = Record<string, unknown>;

const pinterestClient = axios.create({
    timeout: 15000,
    maxRedirects: 0,
    maxContentLength: 5 * 1024 * 1024,
    proxy: false,
    httpAgent: publicHttpAgent,
    httpsAgent: publicHttpsAgent,
    headers: { 'User-Agent': 'Mozilla/5.0' }
});

function asObject(value: unknown): JsonObject | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as JsonObject
        : null;
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function extractPinterestRelay(script: string): JsonObject | null {
    const match = script.match(/window\.__PWS_RELAY_REGISTER_COMPLETED_REQUEST(?:__)?\(([\s\S]*)\);?\s*$/);
    if (!match) return null;

    // Current pages pass an encoded request key followed by the JSON response.
    // Older pages pass just the response. Parse the arguments as JSON, never JS.
    try {
        const args: unknown[] = JSON.parse(`[${match[1]}]`);
        for (const arg of args) {
            const root = asObject(asObject(arg)?.data);
            const query = asObject(root?.v3GetPinQuery) || asObject(root?.v3GetPinQueryv2);
            const pin = asObject(query?.data);
            if (pin) return pin;
        }
    } catch { /* This script is not a completed JSON pin response. */ }
    return null;
}

export class PinterestService {
    public async download(url: string): Promise<PinterestDownload> {
        try {
            let targetUrl = url;
            try {
                new URL(url);
            } catch {
                targetUrl = `https://www.pinterest.com/pin/${url}`;
            }

            const res = await getPublicPage<string>(targetUrl, ['pinterest.com', 'pin.it'], { headers: { 'User-Agent': 'Mozilla/5.0' } });
            const $ = cheerio.load(res.data);
            const data = $('script').toArray()
                .map((script) => extractPinterestRelay($(script).text()))
                .find((pin) => pin !== null);
            if (!data) {
                throw new AppError('Could not find Pinterest pin data', 502);
            }

            const description = stringValue(data.closeupDescription) || stringValue(data.closeupUnifiedDescription) || stringValue(data.gridDescription) || stringValue(data.description);
            const videos = asObject(data.videos);
            const videoUrls = asObject(videos?.videoUrls);
            const videoUrl = videoUrls
                ? Object.values(videoUrls)
                    .map((value) => stringValue(asObject(value)?.url))
                    .find((value) => /\.mp4(?:[?#]|$)/i.test(value)) || null
                : null;
            const image = asObject(data.imageSpec_orig) || asObject(data.images_orig) || asObject(data.images_736x) || asObject(data.images_474x) || asObject(data.images_236x);
            const imageUrl = stringValue(image?.url)
                .replace(/236x|474x|736x/, 'originals') || null;

            if (!videoUrl && !imageUrl) {
                throw new Error('Could not extract media URL');
            }

            const author = asObject(data.closeupUnifiedAttribution) || asObject(data.originPinner) || asObject(data.pinner);
            return {
                title: stringValue(data.title) || stringValue(data.gridTitle),
                description,
                author: stringValue(author?.fullName) || stringValue(author?.username),
                url: videoUrl || imageUrl as string,
                type: videoUrl ? 'video' : 'image'
            };
        } catch (error) {
            if (error instanceof AppError) throw error;
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Pinterest Download Error: ${message}`, 500);
        }
    }

    public async search(query: string): Promise<PinterestSearchResponse> {
        try {
            const pData = { options: { query, page_size: 10, scope: 'pins', source_url: `/search/pins/?q=${encodeURIComponent(query)}` }, context: {} };
            const params = new URLSearchParams({ source_url: pData.options.source_url, data: JSON.stringify(pData), _: String(Date.now()) });
            const res = await pinterestClient.get<JsonObject>(`https://www.pinterest.com/resource/BaseSearchResource/get/?${params}`, { headers: { 'x-pinterest-pws-handler': 'www/search/[scope].js' } });
            const resourceResponse = asObject(res.data.resource_response);
            const responseData = asObject(resourceResponse?.data);
            const pins = Array.isArray(responseData?.results) ? responseData.results : [];
            const results: PinterestSearchItem[] = [];

            for (const pinValue of pins) {
                const pin = asObject(pinValue);
                const images = asObject(pin?.images);
                const originalImage = asObject(images?.orig);
                const id = stringValue(pin?.id);
                const imageUrl = stringValue(originalImage?.url);
                if (!id || !imageUrl) continue;
                const author = asObject(pin?.native_creator) || asObject(pin?.pinner);
                results.push({
                    id,
                    title: stringValue(pin?.description) || stringValue(pin?.alt_text) || stringValue(pin?.auto_alt_text),
                    images: [imageUrl],
                    author: stringValue(author?.full_name) || stringValue(author?.username),
                    link: `https://pinterest.com/pin/${id}`
                });
                if (results.length === 10) break;
            }

            return { results };
        } catch (error) {
            if (error instanceof AppError) throw error;
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Pinterest Search Error: ${message}`, 500);
        }
    }

    public extractUsername(input: string): string {
        const trimmed = input.trim();
        if (!trimmed) {
            throw new AppError('Pinterest username or profile URL is required', 400);
        }
        try {
            const parsed = new URL(trimmed.startsWith('http://') || trimmed.startsWith('https://') ? trimmed : `https://${trimmed}`);
            const host = parsed.hostname.toLowerCase();
            if (['pinterest.com', 'pin.it'].some((h) => host === h || host.endsWith(`.${h}`))) {
                const parts = parsed.pathname.split('/').filter(Boolean);
                if (parts.length > 0 && !['pin', 'search', 'resource', 'today', 'ideas'].includes(parts[0])) {
                    return parts[0].replace(/^@/, '');
                }
            }
        } catch {
            // Not a URL, continue
        }
        const clean = trimmed.replace(/^@/, '').replace(/\/+$/, '');
        if (!/^[a-zA-Z0-9_\-.]+$/.test(clean)) {
            throw new AppError('Invalid Pinterest username format', 400);
        }
        return clean;
    }

    public async user(usernameOrUrl: string): Promise<PinterestUserResponse> {
        try {
            const username = this.extractUsername(usernameOrUrl);

            const profileData = { options: { username }, context: {} };
            const profileParams = new URLSearchParams({
                source_url: `/${username}/`,
                data: JSON.stringify(profileData),
                _: String(Date.now())
            });

            const profileRes = await pinterestClient.get<JsonObject>(
                `https://www.pinterest.com/resource/UserResource/get/?${profileParams}`,
                { headers: { 'x-pinterest-pws-handler': 'www/[username].js' } }
            );

            const resourceResponse = asObject(profileRes.data?.resource_response);
            const userData = asObject(resourceResponse?.data);

            const pinsData = { options: { username, page_size: 15 }, context: {} };
            const pinsParams = new URLSearchParams({
                source_url: `/${username}/`,
                data: JSON.stringify(pinsData),
                _: String(Date.now())
            });

            let rawPins: unknown[] = [];
            try {
                const pinsRes = await pinterestClient.get<JsonObject>(
                    `https://www.pinterest.com/resource/UserPinsResource/get/?${pinsParams}`,
                    { headers: { 'x-pinterest-pws-handler': 'www/[username]/[slug].js' } }
                );
                const pinsResource = asObject(pinsRes.data?.resource_response);
                const responseData = pinsResource?.data;
                if (Array.isArray(responseData)) {
                    rawPins = responseData;
                } else if (asObject(responseData) && Array.isArray(asObject(responseData)?.results)) {
                    rawPins = asObject(responseData)?.results as unknown[];
                }
            } catch {
                // If UserPinsResource fails, fallback to search by user
            }

            if (rawPins.length === 0) {
                try {
                    const fallbackSearch = await this.search(username);
                    if (fallbackSearch.results.length > 0) {
                        return {
                            user: {
                                username: stringValue(userData?.username) || username,
                                fullName: stringValue(userData?.full_name) || stringValue(userData?.username) || username,
                                bio: stringValue(userData?.about) || undefined,
                                avatar: stringValue(userData?.image_xlarge_url) || stringValue(userData?.image_large_url) || stringValue(userData?.image_medium_url) || undefined,
                                followers: typeof userData?.follower_count === 'number' ? userData.follower_count : undefined,
                                following: typeof userData?.following_count === 'number' ? userData.following_count : undefined,
                                pinsCount: typeof userData?.pin_count === 'number' ? userData.pin_count : undefined,
                                boardsCount: typeof userData?.board_count === 'number' ? userData.board_count : undefined
                            },
                            pins: fallbackSearch.results
                        };
                    }
                } catch {
                    // Ignore fallback search error
                }
            }

            const results: PinterestSearchItem[] = [];
            for (const pinValue of rawPins) {
                const pin = asObject(pinValue);
                const images = asObject(pin?.images);
                const originalImage = asObject(images?.orig) || asObject(images?.['736x']);
                const id = stringValue(pin?.id);
                const imageUrl = stringValue(originalImage?.url);
                if (!id || !imageUrl) continue;
                const author = asObject(pin?.native_creator) || asObject(pin?.pinner);
                results.push({
                    id,
                    title: stringValue(pin?.grid_title) || stringValue(pin?.title) || stringValue(pin?.description) || stringValue(pin?.alt_text),
                    images: [imageUrl],
                    author: stringValue(author?.full_name) || stringValue(author?.username) || username,
                    link: `https://pinterest.com/pin/${id}`
                });
                if (results.length === 15) break;
            }

            return {
                user: {
                    username: stringValue(userData?.username) || username,
                    fullName: stringValue(userData?.full_name) || stringValue(userData?.username) || username,
                    bio: stringValue(userData?.about) || undefined,
                    avatar: stringValue(userData?.image_xlarge_url) || stringValue(userData?.image_large_url) || stringValue(userData?.image_medium_url) || undefined,
                    followers: typeof userData?.follower_count === 'number' ? userData.follower_count : undefined,
                    following: typeof userData?.following_count === 'number' ? userData.following_count : undefined,
                    pinsCount: typeof userData?.pin_count === 'number' ? userData.pin_count : undefined,
                    boardsCount: typeof userData?.board_count === 'number' ? userData.board_count : undefined
                },
                pins: results
            };
        } catch (error) {
            if (error instanceof AppError) throw error;
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Pinterest User Error: ${message}`, 500);
        }
    }
}
