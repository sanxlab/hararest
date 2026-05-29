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
import { InstagramMediaInfo, InstagramMedia } from './instagram.types';
import logger from '../../utils/logger';

const execFilePromise = util.promisify(execFile);

interface SnapInstaMediaLink {
    url: string;
    text?: string;
    title?: string;
}

interface SnapInstaResponse {
    status?: string;
    message?: string;
    media_links?: SnapInstaMediaLink[];
}

export class InstagramService {
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

    private resolveSnapInstaScriptPath(): string {
        const envScriptPath = process.env.INSTAGRAM_FALLBACK_PYTHON_SCRIPT;
        const candidates = [
            envScriptPath,
            path.resolve(process.cwd(), 'snapinsta_scraper.py'),
        ].filter((x): x is string => !!x);

        const scriptPath = candidates.find((candidate) => fs.existsSync(candidate));
        if (!scriptPath) {
            throw new AppError('SnapInsta fallback script not found', 500);
        }

        return scriptPath;
    }

    private classifySnapInstaLink(link: SnapInstaMediaLink): 'photo' | 'video' {
        const probe = `${link.text || ''} ${link.title || ''} ${link.url || ''}`.toLowerCase();

        if (
            probe.includes('photo') ||
            probe.includes('.jpg') ||
            probe.includes('.jpeg') ||
            probe.includes('.png') ||
            probe.includes('.webp')
        ) {
            return 'photo';
        }

        return 'video';
    }

    private extractScriptError(stderr: string, fallback = 'SnapInsta fallback failed'): string {
        const raw = stderr.trim();
        if (!raw) return fallback;

        try {
            const parsed = JSON.parse(raw) as { message?: string };
            return parsed.message || fallback;
        } catch {
            return raw;
        }
    }

    private async getMediaInfoFromSnapInsta(url: string): Promise<InstagramMediaInfo> {
        const scriptPath = this.resolveSnapInstaScriptPath();

        let stdout = '';
        try {
            const run = await execFilePromise(
                this.pythonBin,
                [scriptPath, url],
                { maxBuffer: 1024 * 1024 * 10, timeout: 120000 }
            );
            stdout = run.stdout;
        } catch (error: unknown) {
            const err = error as { stderr?: string; message?: string };
            const extracted = this.extractScriptError(err.stderr || '', err.message || 'SnapInsta fallback failed');
            throw new AppError(extracted, 500);
        }

        let parsed: SnapInstaResponse;
        try {
            parsed = JSON.parse(stdout) as SnapInstaResponse;
        } catch {
            throw new AppError('SnapInsta fallback returned invalid JSON', 500);
        }

        if (parsed.status !== 'ok') {
            throw new AppError(parsed.message || 'SnapInsta fallback failed', 500);
        }

        const links = Array.isArray(parsed.media_links)
            ? parsed.media_links.filter((item) => !!item && typeof item.url === 'string' && item.url.length > 0)
            : [];

        if (links.length === 0) {
            throw new AppError('Media not found or private', 404);
        }

        const resolvedItems = await Promise.all(
            links.map(async (link) => {
                const size = await this.getSize(link.url);
                return {
                    kind: this.classifySnapInstaLink(link),
                    media: {
                        url: link.url,
                        size,
                        fSize: this.bytesToSize(size)
                    } as InstagramMedia
                };
            })
        );

        const photos = resolvedItems.filter((x) => x.kind === 'photo').map((x) => x.media);
        const videos = resolvedItems.filter((x) => x.kind === 'video').map((x) => x.media);

        return {
            thumbnail: photos[0]?.url || '',
            photos,
            videos
        };
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
            if (error instanceof AppError && error.statusCode === 400) {
                throw error;
            }

            const primaryError = error instanceof AppError
                ? error.message
                : error instanceof Error
                    ? error.message
                    : 'Unknown error';

            logger.warn('Instagram primary extractor failed, using SnapInsta fallback', {
                url,
                primaryError
            });

            try {
                return await this.getMediaInfoFromSnapInsta(url);
            } catch (fallbackError) {
                if (fallbackError instanceof AppError) {
                    throw fallbackError;
                }

                const fallbackMessage = fallbackError instanceof Error ? fallbackError.message : 'Unknown error';
                throw new AppError(`Failed to fetch Instagram media. Fallback error: ${fallbackMessage}`, 500);
            }
        }
    }
}
