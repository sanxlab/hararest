import FormData from 'form-data';
import beautify from 'js-beautify';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import similarity from 'similarity';
import { AppError } from '../../utils/AppError';
import { FacebookVideoInfo } from './facebook.types';

export class FacebookService {
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

    public async getVideoInfo(url: string): Promise<FacebookVideoInfo> {
        if (!url) {
            throw new AppError('URL Required', 400);
        }

        try {
            const { hostname } = new URL(url);
            const sim = similarity('facebook.com', hostname);
            if (!(sim >= 0.65 || hostname.includes('facebook.com'))) {
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

            // Safe(r) eval containment
            let js: string;
            try {
                // eslint-disable-next-line @typescript-eslint/no-unused-vars
                const window = {
                    location: new URL('https://dev.snapsave.app')
                };

                // Using new Function instead of eval for slightly better scope isolation, 
                // though still risky if input is malicious.
                // The original code used eval(script.replace("eval", "")) which essentially unpacks the packer code
                // We track the original logic:
                // 1. Unpack the code
                // 2. Format it
                // 3. Extract the inner HTML generator

                // Note: Direct eval is used here to match original logic, wrapped in try-catch
                // Typescript dislikes eval, so we cast to any or suppress

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const evalResult = (0, eval)(script.replace('eval', ''));
                js = beautify(evalResult).split('\n')[2];
            } catch (error) {
                throw new AppError('Failed to decode response from Snapsave', 500);
            }

            let html: string;
            try {
                // The unpacked JS usually contains a function or expression that generates HTML
                // We extract the part inside eval() again?
                // Original: const html = eval(js.slice(js.indexOf("<") - 1, -1));
                const innerCode = js.slice(js.indexOf('<') - 1, -1);
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                html = (0, eval)(innerCode);
            } catch (err) {
                // If the double eval fails, it might be that the structure changed
                // We can try to parse whatever we got
                throw new AppError('Failed to execute decoded script', 500);
            }

            const $ = cheerio.load(html);

            const thumbnail = $('.image > img').attr('src');
            if (!thumbnail) {
                // If we can't find thumbnail, it might mean the video wasn't found or private
                const errorMsg = $('div.alert-danger').text() || 'Video not found or private';
                throw new AppError(errorMsg.trim(), 404);
            }

            const videos: any[] = [];
            const rows = $('table > tbody > tr').toArray();

            for (const row of rows) {
                const _$ = cheerio.load(row);
                // Alternatively use $(row).find(...) 

                const quality = $(row).find('.video-quality').text();
                let videoUrlString = $(row).find('a').attr('href');

                if (!videoUrlString) continue;

                const videoUrl = new URL(videoUrlString);
                videoUrl.searchParams.delete('dl');

                const finalUrl = videoUrl.toString();
                const size = await this.getSize(finalUrl);
                const fSize = this.bytesToSize(size);

                videos.push({
                    quality,
                    url: finalUrl,
                    size,
                    fSize
                });
            }

            return {
                thumbnail,
                videos
            };

        } catch (error) {
            if (error instanceof AppError) throw error;
            throw new AppError('Failed to fetch Facebook video', 500);
        }
    }
}
