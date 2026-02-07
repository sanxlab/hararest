import axios from 'axios';
import * as cheerio from 'cheerio';
import { AppError } from '../../utils/AppError';
import { XiaohongshuResult, XiaohongshuImage, XiaohongshuVideo } from './xiaohongshu.types';

export class XiaohongshuService {
    public async download(url: string): Promise<XiaohongshuResult> {
        if (!url) {
            throw new AppError('URL is required', 400);
        }

        try {
            const { data: html } = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36'
                }
            });

            const $ = cheerio.load(html);
            const script = $('script').toArray()
                .map((el) => $(el).text())
                .find((str) => str.includes('window.__INITIAL_STATE__'));

            if (!script) {
                throw new AppError('Failed to parse Xiaohongshu page: Initial state not found', 500);
            }

            const cleanerScript = script.replace('window.__INITIAL_STATE__=', '');

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let rawData: any;
            try {
                // Attempt to use the user's eval method as it handles JS object literals that JSON.parse might not
                // Using indirect eval for safety in some contexts, though here we trust the content is from the page
                // wrapping in parenthesis to ensure object literal is parsed as expression
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                rawData = (0, eval)(`(${cleanerScript})`);
            } catch (e) {
                throw new AppError('Failed to parse (eval) initial state', 500);
            }

            if (!rawData || !rawData.noteData || !rawData.noteData.data) {
                throw new AppError('Invalid data structure received from Xiaohongshu', 500);
            }

            const data = rawData.noteData.data;
            const comments = data.commentData?.commentCount || 0;

            let stream: any = null;
            try {
                if (data.type === 'video' && data.video?.media?.stream) {
                    const { av1, h264, h265, h266 } = data.video.media.stream;
                    stream = [
                        ...(h265 || []),
                        ...(h266 || []),
                        ...(h264 || []),
                        ...(av1 || [])
                    ][0];
                }
            } catch (err) {
                // Ignore stream extraction error, stream remains null
            }

            const images: XiaohongshuImage[] = (data.imageList || [])
                .filter((v: any) => data.type !== 'video' && v.fileId !== data.cover?.fileId)
                .map((v: any) => ({
                    url: v.url,
                    width: v.width,
                    height: v.height,
                    livePhoto: !!v.livePhoto
                }));

            let video: XiaohongshuVideo | null = null;
            if (data.type === 'video' && stream) {
                video = {
                    width: stream.width,
                    height: stream.height,
                    bitrate: stream.videoBitrate,
                    duration: stream.duration,
                    size: stream.size,
                    url: stream.masterUrl
                };
            }

            return {
                id: data.noteId,
                uploaded: data.time,
                type: data.type,
                title: data.title,
                description: data.desc,
                author: {
                    id: data.user.userId,
                    name: data.user.nickName,
                    avatar: data.user.avatar
                },
                tags: (data.tagList || []).map((v: any) => ({ id: v.id, name: v.name })),
                liked: data.interactInfo?.likedCount || '0',
                saved: data.interactInfo?.collectedCount || '0',
                share: data.interactInfo?.shareCount || '0',
                comments,
                recommended: data.interactInfo?.niceCount || '0',
                cover: data.type !== 'video' && data.cover ? data.imageList?.find((v: any) => v.fileId === data.cover.fileId)?.url || null : (data.cover?.url || null),
                images,
                video
            };

        } catch (error) {
            if (error instanceof AppError) throw error;
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Xiaohongshu Download Error: ${message}`, 500);
        }
    }
}
