import axios from 'axios';
import * as cheerio from 'cheerio';
import { AppError } from '../../utils/AppError';
import { PinterestDownload, PinterestSearchResponse, PinterestSearchItem } from './pinterest.types';

type JsonObject = Record<string, unknown>;

const pinterestClient = axios.create({
    timeout: 15000,
    maxRedirects: 0,
    maxContentLength: 5 * 1024 * 1024,
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

function extractPinterestRelay(script: string): JsonObject {
    const match = script.match(/window\.__PWS_RELAY_REGISTER_COMPLETED_REQUEST\((\{[\s\S]*\})\);?\s*$/);
    if (!match) {
        throw new Error('Could not find Pinterest pin data');
    }

    const payload: unknown = JSON.parse(match[1]);
    const json = asObject(payload);
    if (!json) {
        throw new Error('Pinterest pin data is invalid');
    }
    return json;
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

            const res = await pinterestClient.get<string>(targetUrl);
            const $ = cheerio.load(res.data);
            const script = $('script:contains("v3GetPinQuery"):last()').text();
            const json = extractPinterestRelay(script);
            const dataRoot = asObject(json.data);
            const v3Query = asObject(dataRoot?.v3GetPinQuery) || asObject(dataRoot?.v3GetPinQueryv2);
            const data = asObject(v3Query?.data);
            if (!data) {
                throw new Error('Could not find Pinterest pin data');
            }

            const description = stringValue(data.closeupDescription) || stringValue(data.closeupUnifiedDescription) || stringValue(data.gridDescription) || stringValue(data.description);
            const videos = asObject(data.videos);
            const videoUrls = asObject(videos?.videoUrls);
            const videoUrl = videoUrls
                ? Object.values(videoUrls)
                    .map((value) => stringValue(asObject(value)?.url))
                    .find((value) => value.endsWith('.mp4')) || null
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
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Pinterest Download Error: ${message}`, 500);
        }
    }

    public async search(query: string): Promise<PinterestSearchResponse> {
        try {
            const pData = { options: { query, page_size: 100, scope: 'pins', source_url: `/search/pins/?q=${encodeURIComponent(query)}` }, context: {} };
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
            }

            return { results: results.slice(0, 10) };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Pinterest Search Error: ${message}`, 500);
        }
    }
}
