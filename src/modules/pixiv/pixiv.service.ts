import axios from 'axios';
import { AppError } from '../../utils/AppError';
import { PixivDownload, PixivSearchResponse, PixivSearchItem } from './pixiv.types';

type PixivPageResponse = { data?: { error?: boolean; body?: Array<{ urls?: { original?: string } }> } };
type PixivSearchData = { id?: string; title?: string; url?: string; userName?: string };

export class PixivService {
    private readonly headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://www.pixiv.net/'
    };

    private extractId(urlOrId: string): string {
        const match = urlOrId.match(/\d{8,}/);
        if (match) return match[0];
        return urlOrId.replace(/\D/g, '');
    }

    public async download(urlOrId: string): Promise<PixivDownload> {
        try {
            const id = this.extractId(urlOrId);
            if (!id) throw new Error("Invalid Pixiv ID or URL");

            // Fetch illust details
            const response = await axios.get(`https://www.pixiv.net/ajax/illust/${id}`, { headers: this.headers });
            if (response.data?.error) {
                throw new Error(response.data.message || "Failed to fetch from Pixiv");
            }

            const body = response.data.body;
            const urls: string[] = [];
            // Always fetch pages to get original URLs because it bypasses NSFW URL nullification
            let pagesRes: PixivPageResponse | null = null;
            try {
                pagesRes = await axios.get(`https://www.pixiv.net/ajax/illust/${id}/pages`, { headers: this.headers });
            } catch {
                // Ignore 404 errors for R-18
            }
            if (pagesRes && !pagesRes.data?.error && pagesRes.data?.body && pagesRes.data.body.length > 0) {
                for (const page of pagesRes.data.body) {
                    if (page.urls?.original) urls.push(page.urls.original);
                }
            } else if (body.urls && body.urls.original) {
                // Fallback
                urls.push(body.urls.original);
            } else if (body.userIllusts && body.userIllusts[id] && body.userIllusts[id].url) {
                // R-18 fallback workaround: derive from square URL
                const sqUrl = body.userIllusts[id].url;
                const match = sqUrl.match(/img\/(.*?_p)0/);
                if (match) {
                    const basePath = match[1]; // e.g. 2026/08/01/12/05/25/147878257-hash_p
                    const baseUrl = `https://i.pximg.net/img-original/img/${basePath}0`;
                    
                    let foundExt = '.jpg';
                    for (const ext of ['.jpg', '.png', '.gif']) {
                        try {
                            await axios.head(`${baseUrl}${ext}`, { headers: this.headers });
                            foundExt = ext;
                            break;
                        } catch {
                            // Ignore 404
                        }
                    }
                    
                    const pageCount = body.pageCount || 1;
                    for (let i = 0; i < pageCount; i++) {
                        urls.push(`https://i.pximg.net/img-original/img/${basePath}${i}${foundExt}`);
                    }
                }
            }

            if (urls.length === 0) {
                 throw new Error("Could not extract original URLs from Pixiv response.");
            }

            return {
                id: body.id,
                title: body.title,
                description: body.description || '',
                author: body.userName,
                urls
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Pixiv Download Error: ${message}`, 500);
        }
    }

    public async search(query: string): Promise<PixivSearchResponse> {
        try {
            const url = `https://www.pixiv.net/ajax/search/artworks/${encodeURIComponent(query)}?word=${encodeURIComponent(query)}&order=date_d&mode=all&p=1&s_mode=s_tag_full`;
            const response = await axios.get(url, { headers: this.headers });
            
            if (response.data?.error) {
                throw new Error(response.data.message || "Failed to search on Pixiv");
            }

            const illusts = response.data?.body?.illustManga?.data as PixivSearchData[] | undefined;
            const results: PixivSearchItem[] = (illusts || [])
                .filter((item): item is Required<PixivSearchData> => !!item.id && !!item.title && !!item.url && !!item.userName)
                .map((item) => ({
                    id: item.id,
                    title: item.title,
                    url: item.url,
                    author: item.userName
                }));

            return { results: results.slice(0, 10) }; // Return top 10
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Pixiv Search Error: ${message}`, 500);
        }
    }
}
