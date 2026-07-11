import axios from 'axios';
import * as cheerio from 'cheerio';
import { AppError } from '../../utils/AppError';
import { XiaohongshuResult, XiaohongshuImage } from './xiaohongshu.types';

interface XiaohongshuTagState {
    id?: string;
    name?: string;
}

interface XiaohongshuUserState {
    userId?: string;
    nickName?: string;
    avatar?: string;
}

interface XiaohongshuImageState {
    fileId?: string;
    url?: string;
    width?: number;
    height?: number;
    livePhoto?: boolean;
}

interface XiaohongshuVideoStream {
    width?: number;
    height?: number;
    videoBitrate?: number;
    duration?: number;
    size?: number;
    masterUrl?: string;
}

interface XiaohongshuNoteState {
    noteId?: string;
    time?: number;
    type?: string;
    title?: string;
    desc?: string;
    user?: XiaohongshuUserState;
    tagList?: XiaohongshuTagState[];
    interactInfo?: {
        likedCount?: string | number;
        collectedCount?: string | number;
        shareCount?: string | number;
        niceCount?: string | number;
    };
    cover?: XiaohongshuImageState;
    imageList?: XiaohongshuImageState[];
    video?: {
        media?: {
            stream?: Record<string, XiaohongshuVideoStream[]>;
        };
    };
}

interface XiaohongshuStateRoot {
    noteData?: {
        data?: {
            noteData?: XiaohongshuNoteState;
            commentData?: {
                commentCount?: number;
            };
        };
    };
}

export class XiaohongshuService {
    private readonly userAgent =
        'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36';

    public async download(url: string): Promise<XiaohongshuResult> {
        if (!url) {
            throw new AppError('URL is required', 400);
        }

        try {
            const html = await this.fetchHTML(url);
            const stateJSON = this.extractInitialState(html);
            const sanitizedJSON = this.sanitizeJSObjectToJSON(stateJSON);

            let root: XiaohongshuStateRoot;
            try {
                root = JSON.parse(sanitizedJSON) as XiaohongshuStateRoot;
            } catch {
                throw new AppError('Failed to parse initial state JSON', 500);
            }

            const noteData = root.noteData?.data?.noteData;
            const commentCount = root.noteData?.data?.commentData?.commentCount || 0;

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
                tags: (noteData.tagList || []).map((tag) => ({
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

                for (const item of noteData.imageList || []) {
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

                result.cover = coverUrl || (noteData.cover?.url ? String(noteData.cover.url) : null);
                result.images = images;
            } else {
                const mediaStream = noteData.video?.media?.stream;
                const chosenStream = mediaStream
                    ? this.firstStream(mediaStream, ['h265', 'h266', 'h264', 'av1'])
                    : null;

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

            return result;
        } catch (error) {
            if (error instanceof AppError) throw error;
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Xiaohongshu Download Error: ${message}`, 500);
        }
    }

    private async fetchHTML(url: string): Promise<string> {
        const { data } = await axios.get<string>(url, {
            headers: {
                'User-Agent': this.userAgent,
                Accept: 'text/html,application/xhtml+xml'
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
                return false;
            }
        });

        if (!scriptContent) {
            throw new AppError('Initial state script not found', 500);
        }

        const match = scriptContent.match(/window\.__INITIAL_STATE__\s*=\s*(\{.*\})\s*;?/);
        if (match && match[1]) {
            return match[1];
        }

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
        let s = str.trim();

        s = s.replace(/:\s*undefined\b/g, ':null');
        s = s.replace(/=\s*undefined\b/g, '=null');
        s = s.replace(/\bundefined\b/g, 'null');

        s = s.replace(/\bNaN\b/g, 'null');
        s = s.replace(/\b(Infinity|-Infinity)\b/g, 'null');

        return s;
    }

    private firstStream(
        streamMap: Record<string, XiaohongshuVideoStream[]>,
        keys: string[]
    ): XiaohongshuVideoStream | null {
        for (const key of keys) {
            const streams = streamMap[key];
            if (Array.isArray(streams) && streams.length > 0) {
                return streams[0];
            }
        }
        return null;
    }
}
