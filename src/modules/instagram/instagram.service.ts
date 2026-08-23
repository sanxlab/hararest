import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
import fetch from 'node-fetch';
import { AppError } from '../../utils/AppError';
import { InstagramMediaInfo, InstagramMedia } from './instagram.types';

const execFilePromise = util.promisify(execFile);
const allowedInstagramHosts = ['instagram.com', 'instagr.am'] as const;

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
            const res = await fetch(url, { method: 'HEAD', redirect: 'error', timeout: 10000 });
            if (!res.ok) return 0;
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
            path.resolve(process.cwd(), 'src/modules/instagram/snapinsta_scraper.py'),
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
            const { hostname, protocol } = new URL(url);
            const normalizedHost = hostname.toLowerCase();
            const isAllowed = allowedInstagramHosts.some(
                (host) => normalizedHost === host || normalizedHost.endsWith(`.${host}`)
            );
            if ((protocol !== 'http:' && protocol !== 'https:') || !isAllowed) {
                throw new AppError('Invalid URL', 400);
            }
        } catch {
            throw new AppError('Invalid URL', 400);
        }

        return this.getMediaInfoFromSnapInsta(url);
    }
}
