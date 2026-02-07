import FormData from 'form-data';
import beautify from 'js-beautify';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import similarity from 'similarity';
import { AppError } from '../../utils/AppError';
import { InstagramMediaInfo, InstagramMedia } from './instagram.types';

export class InstagramService {
    private async getSize(url: string): Promise<number> {
        try {
            const res = await fetch(url, { method: 'HEAD' });
            return parseInt(res.headers.get('content-length') || '0', 10);
        } catch {
            return 0;
        }
    }

    private bytesToSize(bytes: number): string {
        const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
        if (bytes === 0 || isNaN(bytes)) return '0 B';
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
    }

    public async getMediaInfo(url: string): Promise<InstagramMediaInfo> {
        if (!url) {
            throw new AppError('URL Required', 400);
        }

        try {
            const { hostname } = new URL(url);
            const sim = similarity('instagram.com', hostname);
            if (!(sim >= 0.65 || hostname.includes('instagram.com'))) {
                throw new AppError('Invalid URL', 400);
            }
        } catch {
            throw new AppError('Invalid URL', 400);
        }

        const form = new FormData();
        form.append('url', url);

        try {
            const res = await fetch('https://snapsave.app/action.php', {
                headers: {
                    'User-Agent': 'WhatsApp/2.24.6.21',
                    'Referer': 'https://snapsave.app/'
                },
                body: form,
                method: 'POST'
            });

            const script = await res.text();

            let js: string;
            try {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const window = {
                    location: new URL('https://dev.snapsave.app')
                };

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const evalResult = (0, eval)(script.replace('eval', ''));
                js = beautify(evalResult).split('\n')[2];
            } catch (error) {
                throw new AppError('Failed to decode response from Snapsave', 500);
            }

            let html: string;
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const innerCode = js.slice(js.indexOf('<') - 1, -1);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                html = (0, eval)(innerCode);
            } catch (err) {
                throw new AppError('Failed to execute decoded script', 500);
            }

            const $ = cheerio.load(html);

            const thumbnail = $('img').attr('src');
            if (!thumbnail) {
                const errorMsg = $('div.alert-danger').text() || 'Media not found or private';
                throw new AppError(errorMsg.trim(), 404);
            }

            const photos: InstagramMedia[] = [];
            const videos: InstagramMedia[] = [];

            const links = $('a').toArray();

            for (const link of links) {
                const _$ = cheerio.load(link);
                const text = $(link).text().toLowerCase();
                const href = $(link).attr('href');

                if (!href) continue;

                let targetArray: InstagramMedia[] | undefined;

                if (text.includes('download photo')) {
                    targetArray = photos;
                } else if (text.includes('download video')) {
                    targetArray = videos;
                }

                if (!targetArray) continue;


                const size = await this.getSize(href);
                const fSize = this.bytesToSize(size);

                targetArray.push({
                    url: href,
                    size,
                    fSize
                });
            }

            return {
                thumbnail,
                photos,
                videos
            };

        } catch (error) {
            if (error instanceof AppError) throw error;
            throw new AppError('Failed to fetch Instagram media', 500);
        }
    }
}
