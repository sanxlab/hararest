import axios from 'axios';
import { AppError } from '../../utils/AppError';
import { publicHttpAgent, publicHttpsAgent } from '../../utils/publicAgent';
import { PixivDownload, PixivSearchResponse, PixivSearchItem, PixivUserProfile, PixivUserArtwork, PixivUserResponse } from './pixiv.types';

type PixivPageResponse = { data?: { error?: boolean; body?: Array<{ urls?: { original?: string } }> } };
type PixivSearchData = { id?: string; title?: string; url?: string; userName?: string; xRestrict?: number; tags?: string[] };
const MAX_PAGE_COUNT = 1000;

export class PixivService {
    private readonly headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.pixiv.net/'
    };
    private readonly requestOptions = {
        headers: this.headers,
        timeout: 15000,
        maxRedirects: 0,
        maxContentLength: 5 * 1024 * 1024,
        proxy: false as const,
        httpAgent: publicHttpAgent,
        httpsAgent: publicHttpsAgent
    };

    private extractId(urlOrId: string): string {
        const value = urlOrId.trim();
        if (/^[1-9]\d*$/.test(value)) return value;
        try {
            const url = new URL(value);
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
                !(url.hostname === 'pixiv.net' || url.hostname.endsWith('.pixiv.net'))) throw new Error();
            const match = url.pathname.match(/^\/(?:[a-z]{2}\/)?artworks\/([1-9]\d*)\/?$/);
            if (match) return match[1];
            const legacyId = url.searchParams.get('illust_id');
            if (url.pathname === '/member_illust.php' && legacyId && /^[1-9]\d*$/.test(legacyId)) return legacyId;
        } catch { /* Invalid URLs are reported as client errors below. */ }
        throw new AppError('Invalid Pixiv ID or artwork URL', 400);
    }

    public async download(urlOrId: string): Promise<PixivDownload> {
        try {
            const id = this.extractId(urlOrId);
            if (!id) throw new Error("Invalid Pixiv ID or URL");

            // Fetch illust details
            const response = await axios.get(`https://www.pixiv.net/ajax/illust/${id}`, this.requestOptions);
            if (response.data?.error) {
                throw new Error(response.data.message || "Failed to fetch from Pixiv");
            }

            const body = response.data?.body;
            if (!body || typeof body !== 'object') throw new AppError('Invalid Pixiv response', 502);
            const urls: string[] = [];
            // Always fetch pages to get original URLs because it bypasses NSFW URL nullification
            let pagesRes: PixivPageResponse | null = null;
            try {
                pagesRes = await axios.get(`https://www.pixiv.net/ajax/illust/${id}/pages`, this.requestOptions);
            } catch {
                // Ignore 404 errors for R-18
            }
            const pages = pagesRes?.data?.body;
            if (pages && (!Array.isArray(pages) || pages.length > MAX_PAGE_COUNT)) {
                throw new AppError('Invalid Pixiv page data', 502);
            }
            if (pagesRes && !pagesRes.data?.error && pages && pages.length > 0) {
                for (const page of pages) {
                    if (page.urls?.original) urls.push(page.urls.original);
                }
            } else if (body.urls && body.urls.original) {
                // Fallback
                urls.push(body.urls.original);
            } else if (body.userIllusts && body.userIllusts[id] && body.userIllusts[id].url) {
                // R-18 fallback workaround: derive from square URL
                const sqUrl = body.userIllusts[id].url;
                const pageCount = body.pageCount ?? 1;
                if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > MAX_PAGE_COUNT) {
                    throw new AppError('Invalid Pixiv page count', 502);
                }
                const match = sqUrl.match(/img\/(.*?_p)0/);
                if (match) {
                    const basePath = match[1]; // e.g. 2026/08/01/12/05/25/147878257-hash_p
                    const baseUrl = `https://i.pximg.net/img-original/img/${basePath}0`;
                    
                    let foundExt: string | undefined;
                    for (const ext of ['.jpg', '.png', '.gif']) {
                        try {
                            await axios.head(`${baseUrl}${ext}`, this.requestOptions);
                            foundExt = ext;
                            break;
                        } catch {
                            // Ignore 404
                        }
                    }
                    
                    if (!foundExt) throw new AppError('Original Pixiv media is unavailable.', 404);
                    for (let i = 0; i < pageCount; i++) {
                        urls.push(`https://i.pximg.net/img-original/img/${basePath}${i}${foundExt}`);
                    }
                }
            }

            if (urls.length === 0) {
                 throw new Error("Could not extract original URLs from Pixiv response.");
            }

            const xRestrict = typeof body.xRestrict === 'number' ? body.xRestrict : 0;
            const tagsList = Array.isArray(body.tags?.tags)
                ? (body.tags.tags as Array<{ tag?: string }>).map((t) => t?.tag || '').filter(Boolean)
                : [];
            const isNsfw = xRestrict > 0 || tagsList.some((t: string) => /r-?18/i.test(t));

            return {
                id: body.id,
                title: body.title,
                description: body.description || '',
                author: body.userName,
                urls,
                nsfw: isNsfw,
                xRestrict,
                tags: tagsList
            };
        } catch (error) {
            if (error instanceof AppError) throw error;
            throw new AppError('Pixiv could not retrieve the requested artwork.', 502);
        }
    }

    public async search(query: string, options?: { mode?: 'all' | 'safe' | 'r18'; nsfw?: boolean }): Promise<PixivSearchResponse> {
        try {
            const mode = options?.nsfw ? 'r18' : (options?.mode || 'all');
            const url = `https://www.pixiv.net/ajax/search/artworks/${encodeURIComponent(query)}?word=${encodeURIComponent(query)}&order=date_d&mode=${mode}&p=1&s_mode=s_tag_full`;
            const response = await axios.get(url, this.requestOptions);

            if (response.data?.error) {
                throw new Error(response.data.message || "Failed to search on Pixiv");
            }

            const illusts = response.data?.body?.illustManga?.data as PixivSearchData[] | undefined;
            const results: PixivSearchItem[] = (illusts || [])
                .filter((item): item is Required<PixivSearchData> => !!item.id && !!item.title && !!item.url && !!item.userName)
                .map((item) => {
                    const xRestrict = typeof item.xRestrict === 'number' ? item.xRestrict : 0;
                    const tags = Array.isArray(item.tags) ? item.tags : [];
                    const isNsfw = xRestrict > 0 || tags.some((t) => /r-?18/i.test(t));
                    return {
                        id: item.id,
                        title: item.title,
                        url: item.url,
                        author: item.userName,
                        nsfw: isNsfw,
                        xRestrict,
                        tags
                    };
                });

            return { results: results.slice(0, 10) }; // Return top 10
        } catch (error) {
            if (error instanceof AppError) throw error;
            throw new AppError('Pixiv search is currently unavailable.', 502);
        }
    }

    public extractUserId(urlOrId: string): string {
        const value = urlOrId.trim();
        if (/^[1-9]\d*$/.test(value)) return value;
        try {
            const url = new URL(value.startsWith('http://') || value.startsWith('https://') ? value : `https://${value}`);
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port ||
                !(url.hostname === 'pixiv.net' || url.hostname.endsWith('.pixiv.net'))) throw new Error();
            const match = url.pathname.match(/^\/(?:[a-z]{2}\/)?users\/([1-9]\d*)\/?$/);
            if (match) return match[1];
            const legacyId = url.searchParams.get('id');
            if ((url.pathname === '/member.php' || url.pathname === '/member_illust.php') && legacyId && /^[1-9]\d*$/.test(legacyId)) {
                return legacyId;
            }
        } catch { /* Handled below */ }
        throw new AppError('Invalid Pixiv user ID or profile URL', 400);
    }

    public async user(idOrUrl: string, options?: { mode?: 'all' | 'safe' | 'r18'; nsfw?: boolean }): Promise<PixivUserResponse> {
        try {
            const userId = this.extractUserId(idOrUrl);

            // Fetch user info
            const userRes = await axios.get(`https://www.pixiv.net/ajax/user/${userId}?full=1`, this.requestOptions);
            if (userRes.data?.error) {
                throw new Error(userRes.data.message || 'Failed to fetch user from Pixiv');
            }
            const userBody = userRes.data?.body;
            if (!userBody || typeof userBody !== 'object') {
                throw new AppError('Invalid Pixiv user response', 502);
            }

            // Fetch top illusts/manga
            let topIllusts: Record<string, unknown> = {};
            let topManga: Record<string, unknown> = {};
            try {
                const topRes = await axios.get(`https://www.pixiv.net/ajax/user/${userId}/profile/top?lang=en`, this.requestOptions);
                if (topRes.data && !topRes.data.error && topRes.data.body) {
                    topIllusts = topRes.data.body.illusts || {};
                    topManga = topRes.data.body.manga || {};
                }
            } catch {
                // Ignore top fetch failure, proceed with empty or partial
            }

            type RawArtwork = {
                id?: string | number;
                title?: string;
                url?: string;
                xRestrict?: number;
                tags?: string[];
                pageCount?: number;
                width?: number;
                height?: number;
            };

            const allRaw: RawArtwork[] = [
                ...Object.values(topIllusts),
                ...Object.values(topManga)
            ] as RawArtwork[];

            // Sort newest first (highest ID first)
            allRaw.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));

            const wantNsfw = options?.nsfw === true || options?.mode === 'r18';
            const wantSafe = options?.nsfw === false || options?.mode === 'safe';

            const artworks: PixivUserArtwork[] = [];
            for (const item of allRaw) {
                if (!item.id || !item.url) continue;
                const xRestrict = typeof item.xRestrict === 'number' ? item.xRestrict : 0;
                const tags = Array.isArray(item.tags) ? item.tags : [];
                const isNsfw = xRestrict > 0 || tags.some((t) => /r-?18/i.test(t));

                if (wantNsfw && !isNsfw) continue;
                if (wantSafe && isNsfw) continue;

                artworks.push({
                    id: String(item.id),
                    title: item.title || '',
                    url: item.url,
                    nsfw: isNsfw,
                    xRestrict,
                    tags,
                    pageCount: typeof item.pageCount === 'number' ? item.pageCount : 1,
                    width: item.width,
                    height: item.height
                });
                if (artworks.length === 15) break;
            }

            const profile: PixivUserProfile = {
                id: String(userBody.userId || userId),
                name: userBody.name || '',
                comment: userBody.comment || undefined,
                avatar: userBody.imageBig || userBody.image || undefined,
                premium: !!userBody.premium,
                twitterUrl: userBody.social?.twitter?.url || undefined
            };

            return {
                user: profile,
                artworks
            };
        } catch (error) {
            if (error instanceof AppError) throw error;
            throw new AppError('Pixiv user information is currently unavailable.', 502);
        }
    }
}
