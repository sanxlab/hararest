import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
import fetch from 'node-fetch';
import { AppError } from '../../utils/AppError';
import { FacebookVideoInfo, FacebookVideo } from './facebook.types';

const execFilePromise = util.promisify(execFile);
const allowedFacebookHosts = ['facebook.com', 'fb.watch', 'fb.gg'] as const;

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

    public async getVideoInfo(url: string): Promise<FacebookVideoInfo> {
        if (!url) {
            throw new AppError('URL Required', 400);
        }

        try {
            const { hostname, protocol } = new URL(url);
            const normalizedHost = hostname.toLowerCase();
            const isAllowed = allowedFacebookHosts.some(
                (host) => normalizedHost === host || normalizedHost.endsWith(`.${host}`)
            );
            if ((protocol !== 'http:' && protocol !== 'https:') || !isAllowed) {
                throw new AppError('Invalid URL', 400);
            }
        } catch {
            throw new AppError('Invalid URL', 400);
        }

        return this.getVideoInfoFromFDown(url);
    }
}
