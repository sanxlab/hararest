import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
import FormData from 'form-data';
import beautify from 'js-beautify';
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import similarity from 'similarity';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { FacebookVideoInfo, FacebookVideo } from './facebook.types';

const execFilePromise = util.promisify(execFile);

interface FDownMediaLink {
    quality?: string;
    label?: string;
    url: string;
}

interface FDownResponse {
    status?: string;
    message?: string;
    media_links?: FDownMediaLink[];
}

export class FacebookService {
    private readonly pythonBin = process.env.PYTHON_BIN || 'python';

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

    private resolveFDownScriptPath(): string {
        const envScriptPath = process.env.FACEBOOK_FALLBACK_PYTHON_SCRIPT;
        const candidates = [
            envScriptPath,
            path.resolve(process.cwd(), 'src/modules/facebook/fdown_scraper.py'),
            path.resolve(process.cwd(), 'fdown_scraper.py')
        ].filter((x): x is string => !!x);

        const scriptPath = candidates.find((candidate) => fs.existsSync(candidate));
        if (!scriptPath) {
            throw new AppError('FDown fallback script not found', 500);
        }

        return scriptPath;
    }

    private extractScriptError(stderr: string, fallback = 'FDown fallback failed'): string {
        const raw = stderr.trim();
        if (!raw) return fallback;

        try {
            const parsed = JSON.parse(raw) as { message?: string };
            return parsed.message || fallback;
        } catch {
            return raw;
        }
    }

    private async getVideoInfoFromFDown(url: string): Promise<FacebookVideoInfo> {
        const scriptPath = this.resolveFDownScriptPath();

        let stdout = '';
        try {
            const run = await execFilePromise(
                this.pythonBin,
                [scriptPath, url],
                { maxBuffer: 1024 * 1024 * 10, timeout: 120000 }
            );
            stdout = typeof run === 'string' ? run : run.stdout || '';
        } catch (error: unknown) {
            const err = error as { stderr?: string; message?: string };
            const extracted = this.extractScriptError(err.stderr || '', err.message || 'FDown fallback failed');
            throw new AppError(extracted, 500);
        }

        let parsed: FDownResponse;
        try {
            parsed = JSON.parse(stdout) as FDownResponse;
        } catch {
            throw new AppError('FDown fallback returned invalid JSON', 500);
        }

        if (parsed.status !== 'ok') {
            throw new AppError(parsed.message || 'FDown fallback failed', 500);
        }

        const links = Array.isArray(parsed.media_links)
            ? parsed.media_links.filter(
                (item) => !!item && typeof item.url === 'string' && item.url.length > 0
            )
            : [];

        if (links.length === 0) {
            throw new AppError('Media not found or private', 404);
        }

        const videos: FacebookVideo[] = await Promise.all(
            links.map(async (link) => {
                const size = await this.getSize(link.url);
                return {
                    quality: (link.quality || link.label || 'unknown').trim(),
                    url: link.url,
                    size,
                    fSize: this.bytesToSize(size)
                };
            })
        );

        return {
            thumbnail: '',
            videos
        };
    }

    private async getVideoInfoFromSnapsave(url: string): Promise<FacebookVideoInfo> {
        const form = new FormData();
        form.append('url', url);

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
        } catch {
            throw new AppError('Failed to decode response from Snapsave', 500);
        }

        let html: string;
        try {
            const innerCode = js.slice(js.indexOf('<') - 1, -1);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            html = (0, eval)(innerCode);
        } catch {
            throw new AppError('Failed to execute decoded script', 500);
        }

        const $ = cheerio.load(html);
        const thumbnail = $('.image > img').attr('src');

        if (!thumbnail) {
            const errorMsg = $('div.alert-danger').text() || 'Video not found or private';
            throw new AppError(errorMsg.trim(), 404);
        }

        const videos: FacebookVideo[] = [];
        const rows = $('table > tbody > tr').toArray();

        for (const row of rows) {
            const quality = $(row).find('.video-quality').text().trim();
            const videoUrlString = $(row).find('a').attr('href');
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

        try {
            return await this.getVideoInfoFromSnapsave(url);
        } catch (error) {
            if (error instanceof AppError && error.statusCode === 400) {
                throw error;
            }

            const primaryError = error instanceof AppError
                ? error.message
                : error instanceof Error
                    ? error.message
                    : 'Unknown error';

            logger.warn('Facebook primary extractor failed, using FDown fallback', {
                url,
                primaryError
            });

            try {
                return await this.getVideoInfoFromFDown(url);
            } catch (fallbackError) {
                if (fallbackError instanceof AppError) {
                    throw fallbackError;
                }

                const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : 'Unknown error';
                throw new AppError(`Failed to fetch Facebook video. Fallback error: ${fallbackMessage}`, 500);
            }
        }
    }
}
