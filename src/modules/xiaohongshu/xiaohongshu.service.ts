import { getPublicPage } from '../../utils/http';
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
    urlDefault?: string;
    urlPre?: string;
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
        commentCount?: string | number;
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
    note?: {
        noteDetailMap?: Record<string, { note?: XiaohongshuNoteState }>;
    };
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
                throw new AppError('Failed to parse Xiaohongshu page data', 502);
            }

            const noteId = new URL(url).pathname.match(/\/(?:explore|discovery\/item)\/([\da-f]+)/i)?.[1];
            const desktopNotes = root.note?.noteDetailMap || {};
            // Short links may resolve to a desktop page; only use an unambiguous note.
            const desktopNote = noteId ? desktopNotes[noteId]?.note
                : Object.keys(desktopNotes).length === 1 ? Object.values(desktopNotes)[0]?.note : undefined;
            const noteData = root.noteData?.data?.noteData || desktopNote;
            const commentCount = root.noteData?.data?.commentData?.commentCount ?? noteData?.interactInfo?.commentCount ?? 0;

            if (!noteData) {
                throw new AppError('Xiaohongshu did not provide the post data. Try a current share link; the post may be unavailable or require login.', 502);
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
                cover: this.imageUrl(noteData.cover) || this.imageUrl(noteData.imageList?.[0]) || null,
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
                        url: this.imageUrl(item),
                        width: Number(item.width || 0),
                        height: Number(item.height || 0),
                        livePhoto: Boolean(item.livePhoto)
                    };

                    if (fileId && fileId === coverFileId && !coverUrl) {
                        coverUrl = img.url;
                    }

                    if (img.url) {
                        images.push(img);
                    }
                }

                result.cover = coverUrl || result.cover;
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

            if (result.type === 'video' ? !result.video?.url : result.images.length === 0) {
                throw new AppError('Xiaohongshu did not provide downloadable media for this post.', 502);
            }
            return result;
        } catch (error) {
            if (error instanceof AppError) throw error;
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Xiaohongshu Download Error: ${message}`, 500);
        }
    }

    private imageUrl(image?: XiaohongshuImageState): string {
        return image?.url || image?.urlDefault || image?.urlPre || '';
    }

    private async fetchHTML(url: string): Promise<string> {
        const { data } = await getPublicPage<string>(url, ['xiaohongshu.com', 'xhslink.com'], {
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
            throw new AppError('Xiaohongshu did not provide page data; the post may be unavailable or require login.', 502);
        }

        const assignment = /window\.__INITIAL_STATE__\s*=\s*/.exec(scriptContent);
        if (!assignment) throw new AppError('Initial state assignment not found', 502);
        const rhs = scriptContent.slice(assignment.index + assignment[0].length);
        // Find the end of the object without consuming later scripts or braces inside strings.
        let depth = 0;
        let quoted = false;
        let escaped = false;
        for (let i = 0; i < rhs.length; i++) {
            const char = rhs[i];
            if (quoted) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') quoted = false;
            } else if (char === '"') quoted = true;
            else if (char === '{') depth++;
            else if (char === '}' && --depth === 0) return rhs.slice(0, i + 1);
        }
        throw new AppError('Initial state is not a complete JSON object', 502);
    }

    private sanitizeJSObjectToJSON(str: string): string {
        // Match JSON strings first so captions containing "undefined" or "NaN" remain intact.
        return str.replace(/"(?:\\.|[^"\\])*"|\bundefined\b|\bNaN\b|-?\bInfinity\b/g,
            (token) => token.startsWith('"') ? token : 'null');
    }

    private firstStream(
        streamMap: Record<string, XiaohongshuVideoStream[]>,
        keys: string[]
    ): XiaohongshuVideoStream | null {
        for (const key of keys) {
            const streams = streamMap[key];
            const playable = Array.isArray(streams) ? streams.find((stream) => stream.masterUrl) : undefined;
            if (playable) return playable;
        }
        return null;
    }
}
