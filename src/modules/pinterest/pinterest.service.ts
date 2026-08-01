import axios from 'axios';
import * as cheerio from 'cheerio';
import { AppError } from '../../utils/AppError';
import { PinterestDownload, PinterestSearchResponse, PinterestSearchItem } from './pinterest.types';

export class PinterestService {
    public async download(url: string): Promise<PinterestDownload> {
        try {
            let targetUrl = url;
            try {
                new URL(url);
            } catch {
                targetUrl = `https://www.pinterest.com/pin/${url}`;
            }

            const res = await axios.get(targetUrl);
            const html = res.data;
            const $ = cheerio.load(html);

            const script = $('script:contains("v3GetPinQuery"):last()')
                .text()
                .replace("window.__PWS_RELAY_REGISTER_COMPLETED_REQUEST__", "json = ");
            
            let json: any = {};
            eval(script);

            const v3Query = json.data?.v3GetPinQuery || json.data?.v3GetPinQueryv2;
            if (!v3Query || !v3Query.data) {
                throw new Error("Could not find Pinterest pin data");
            }
            
            const data = v3Query.data;
            
            const description = (
                data.closeupDescription ||
                data.closeupUnifiedDescription ||
                data.gridDescription ||
                data.description || ""
            );

            let videoUrl: string | null = null;
            if (data.videos?.videoUrls) {
                const urls = Object.values(data.videos.videoUrls).map((v: any) => v.url);
                videoUrl = urls.find((u: string) => u.endsWith(".mp4")) || null;
            } else if (data.storyPinData?.pages?.[0]?.blocks?.[0]?.videoDataV2) {
                const blocks = Object.values(data.storyPinData.pages[0].blocks[0].videoDataV2).filter(Boolean);
                for (const block of blocks) {
                    const u = (Object.values(block as any)[0] as any)?.url;
                    if (u && u.endsWith('.mp4')) {
                        videoUrl = u;
                        break;
                    }
                }
            }

            const author = data.closeupUnifiedAttribution || data.originPinner || data.pinner || {};
            const authorName = author.fullName || author.username || '';

            let imageUrl = (data.imageSpec_orig || data.images_orig || data.images_736x || data.images_474x || data.images_236x || {})?.url || null;
            
            if (imageUrl) {
                 imageUrl = imageUrl.replace(/236x/, 'originals').replace(/474x/, 'originals').replace(/736x/, 'originals');
            }
            
            if (!videoUrl && !imageUrl) {
                throw new Error("Could not extract media URL");
            }

            return {
                title: data.title || data.gridTitle || '',
                description: description,
                author: authorName,
                url: videoUrl || imageUrl,
                type: videoUrl ? 'video' : 'image'
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Pinterest Download Error: ${message}`, 500);
        }
    }

    public async search(query: string): Promise<PinterestSearchResponse> {
        try {
            const p_data = {
                options: {
                    applied_unified_filters: null,
                    appliedProductFilters: "---",
                    article: null,
                    auto_correction_disabled: false,
                    corpus: null,
                    customized_rerank_type: null,
                    domains: null,
                    filters: null,
                    journey_depth: null,
                    page_size: 100,
                    price_max: null,
                    price_min: null,
                    query_pin_sigs: null,
                    query,
                    redux_normalize_feed: true,
                    request_params: null,
                    rs: "direct_navigation",
                    scope: "pins",
                    selected_one_bar_modules: null,
                    seoDrawerEnabled: false,
                    source_id: null,
                    source_module_id: null,
                    source_url: `/search/pins/?q=${encodeURIComponent(query)}`,
                    top_pin_id: null,
                    top_pin_ids: null
                },
                context: {}
            };
            const params = new URLSearchParams({
                source_url: p_data.options.source_url,
                data: JSON.stringify(p_data),
                _: String(Date.now())
            });

            const res = await axios.get("https://www.pinterest.com/resource/BaseSearchResource/get/?" + params.toString(), {
                headers: {
                    "x-pinterest-pws-handler": "www/search/[scope].js"
                }
            });

            const data = res.data.resource_response.data.results;
            const results: PinterestSearchItem[] = [];

            for (const pin of data) {
                const up = pin.native_creator || pin.pinner || {};
                
                let imageUrl = '';
                if (pin.images && pin.images.orig && pin.images.orig.url) {
                    imageUrl = pin.images.orig.url;
                }

                if (pin.id && imageUrl) {
                    results.push({
                        id: pin.id,
                        title: pin.description || pin.alt_text || pin.auto_alt_text || '',
                        images: [imageUrl],
                        author: up.full_name || up.username || '',
                        link: `https://pinterest.com/pin/${pin.id}`
                    });
                }
            }

            return { results: results.slice(0, 10) };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Pinterest Search Error: ${message}`, 500);
        }
    }
}
