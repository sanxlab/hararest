
import axios from 'axios';
import * as cheerio from 'cheerio';
import { AppError } from '../../utils/AppError';
import { XiaohongshuResult, XiaohongshuImage, XiaohongshuVideo } from './xiaohongshu.types';

export class XiaohongshuService {
    private readonly userAgent = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36';

    public async download(url: string): Promise<XiaohongshuResult> {
        if (!url) {
            throw new AppError('URL is required', 400);
        }

        try {
            const html = await this.fetchHTML(url);
            const stateJSON = this.extractInitialState(html);
            const sanitizedJSON = this.sanitizeJSObjectToJSON(stateJSON);

            let root: any;
            try {
                root = JSON.parse(sanitizedJSON);
            } catch (error) {
                throw new AppError('Failed to parse initial state JSON', 500);
            }

            const noteData = root?.noteData?.data?.noteData;
            const commentCount = root?.noteData?.data?.commentData?.commentCount || 0;

            if (!noteData) {
                throw new AppError('Unexpected state: noteData not found', 500);
            }

            const result: XiaohongshuResult = {
                id: String(noteData.noteId || ''),
                uploaded: Number(noteData.time || 0),
                type: String(noteData.type || 'normal') as 'video' | 'normal',
                title: String(noteData.title || ''),
                description: String(noteData.desc || ''),
                author: {
                    id: String(noteData.user?.userId || ''),
                    name: String(noteData.user?.nickName || ''),
                    avatar: String(noteData.user?.avatar || '')
                },
                tags: (noteData.tagList || []).map((tag: any) => ({
                    id: String(tag.id || ''),
                    name: String(tag.name || '')
                })),
                liked: String(noteData.interactInfo?.likedCount || '0'),
                saved: String(noteData.interactInfo?.collectedCount || '0'),
                share: String(noteData.interactInfo?.shareCount || '0'),
                comments: Number(commentCount),
                recommended: String(noteData.interactInfo?.niceCount || '0'),
                cover: null,
                images: [],
                video: null
            };

            const coverFileId = noteData.cover?.fileId ? String(noteData.cover.fileId) : '';

            if (result.type !== 'video') {
                const images: XiaohongshuImage[] = [];
                let coverUrl: string | null = null;

                if (Array.isArray(noteData.imageList)) {
                    for (const item of noteData.imageList) {
                        const fileId = String(item.fileId || '');
                        const img: XiaohongshuImage = {
                            url: String(item.url || ''),
                            width: Number(item.width || 0),
                            height: Number(item.height || 0),
                            livePhoto: Boolean(item.livePhoto)
                        };

                        if (fileId && fileId === coverFileId && !coverUrl) {
                            coverUrl = img.url;
                            continue;
                        }

                        if (fileId && fileId !== coverFileId) {
                            images.push(img);
                        }
                    }
                }

                result.cover = coverUrl || (noteData.cover?.url ? String(noteData.cover.url) : null);
                result.images = images;
            } else {
                const mediaStream = noteData.video?.media?.stream;
                if (mediaStream) {
                    const chosenStream = this.firstStream(mediaStream, ['h265', 'h266', 'h264', 'av1']);
                    if (chosenStream) {
                        result.video = {
                            width: Number(chosenStream.width || 0),
                            height: Number(chosenStream.height || 0),
                            bitrate: Number(chosenStream.videoBitrate || 0),
                            duration: Number(chosenStream.duration || 0),
                            size: Number(chosenStream.size || 0),
                            url: String(chosenStream.masterUrl || '')
                        };
                    }
                }
            }

            return result;

        } catch (error) {
            if (error instanceof AppError) throw error;
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Xiaohongshu Download Error: ${message}`, 500);
        }
    }

    private async fetchHTML(url: string): Promise<string> {
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': this.userAgent,
                'Accept': 'text/html,application/xhtml+xml'
            }
        });
        return data;
    }

    private extractInitialState(html: string): string {
        const $ = cheerio.load(html);
        let scriptContent = '';

        $('script').each((_, el) => {
            const text = $(el).text();
            if (text.includes('window.__INITIAL_STATE__')) {
                scriptContent = text;
                return false; // break loop
            }
        });

        if (!scriptContent) {
            throw new AppError('Initial state script not found', 500);
        }

        // Regex to extract JSON object from window.__INITIAL_STATE__ = { ... }
        const match = scriptContent.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*\})\s*;?/);
        if (match && match[1]) {
            return match[1];
        }

        // Fallback: manual parsing
        const idx = scriptContent.indexOf('window.__INITIAL_STATE__');
        if (idx === -1) throw new AppError('Initial state not found in script', 500);

        const part = scriptContent.substring(idx);
        const eqIdx = part.indexOf('=');
        if (eqIdx === -1) throw new AppError('Initial state assignment not found', 500);

        let rhs = part.substring(eqIdx + 1).trim();
        if (rhs.endsWith(';')) {
            rhs = rhs.slice(0, -1).trim();
        }

        if (!rhs.startsWith('{')) {
            throw new AppError('Initial state is not a JSON object', 500);
        }

        return rhs;
    }

    private sanitizeJSObjectToJSON(str: string): string {
        // Remove BOM and whitespace
        let s = str.trim();

        // Retrieve undefined to null
        s = s.replace(/:\s*undefined\b/g, ':null');
        s = s.replace(/=\s*undefined\b/g, '=null');
        s = s.replace(/\bundefined\b/g, 'null');

        // Retrieve NaN and Infinity to null
        s = s.replace(/\bNaN\b/g, 'null');
        s = s.replace(/\b(Infinity|-Infinity)\b/g, 'null');

        return s;
    }

    // Helper to pick the first available stream based on priority keys
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private firstStream(streamMap: any, keys: string[]): any | null {
        for (const key of keys) {
            if (Array.isArray(streamMap[key]) && streamMap[key].length > 0) {
                return streamMap[key][0];
            }
        }
        return null;
    }
}
