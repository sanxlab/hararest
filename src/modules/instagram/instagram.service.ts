import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import util from 'util';
import { getMediaSize, bytesToSize } from '../../utils/mediaSize';
import { AppError } from '../../utils/AppError';
import { InstagramMediaInfo, InstagramMedia } from './instagram.types';
import { config } from '../../config/default';
import { assertPublicUrl } from '../../middlewares/ssrf.middleware';

const execFilePromise = util.promisify(execFile);
const allowedInstagramHosts = ['instagram.com', 'instagr.am'] as const;
let activeExtractions = 0;

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
            return parsed?.message || fallback;
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
                { maxBuffer: 4 * 1024 * 1024, timeout: 12000, killSignal: 'SIGKILL' }
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

        if (!parsed || parsed.status !== 'ok') {
            throw new AppError(parsed?.message || 'SnapInsta fallback failed', 500);
        }

        const links = Array.isArray(parsed.media_links)
            ? parsed.media_links.filter((item) => !!item && typeof item.url === 'string' && item.url.length > 0)
            : [];

        if (links.length === 0) {
            throw new AppError('Media not found or private', 404);
        }

        const resolvedItems = await Promise.all(
            links.map(async (link) => {
                const size = await getMediaSize(link.url);
                return {
                    kind: this.classifySnapInstaLink(link),
                    media: {
                        url: link.url,
                        size,
                        fSize: bytesToSize(size)
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

    // Public metadata extraction only: no cookies, login, or private downloader.
    private async getMediaInfoFromYtDlp(url: string): Promise<InstagramMediaInfo> {
        const parsed = new URL(url);
        if (!/^\/(?:p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?$/.test(parsed.pathname)) {
            throw new AppError('Instagram media unavailable.', 404);
        }
        const canonicalUrl = `https://www.instagram.com${parsed.pathname}`;
        const { stdout } = await execFilePromise(config.youtube.binPath, [
            '--ignore-config', '--skip-download', '--dump-single-json', '--no-playlist',
            '--socket-timeout', '5', '--retries', '0', '--no-warnings', '--', canonicalUrl,
        ], { maxBuffer: 4 * 1024 * 1024, timeout: 12000, killSignal: 'SIGKILL' });
        interface Media {
            url?: string; ext?: string; filesize?: number; width?: number; height?: number;
            vcodec?: string; acodec?: string; protocol?: string; formats?: Media[]; entries?: Media[];
        }
        const info = JSON.parse(stdout) as Media | null;
        if (!info || typeof info !== 'object') throw new AppError('Instagram media unavailable.', 404);
        const entries = info.entries ?? [info];
        if (!Array.isArray(entries) || entries.length > 20) throw new AppError('Instagram media unavailable.', 422);
        const photos: InstagramMedia[] = [], videos: InstagramMedia[] = [];
        for (const entry of entries) {
            if (!entry || typeof entry !== 'object') continue;
            const formats = Array.isArray(entry.formats) ? entry.formats : [];
            const candidates = [entry, ...formats].filter(item =>
                typeof item?.url === 'string' && /^https?:\/\//.test(item.url) &&
                ['mp4', 'jpg', 'jpeg', 'png', 'webp'].includes(item.ext || '') &&
                (!item.protocol || ['http', 'https'].includes(item.protocol)) &&
                (item.ext !== 'mp4' || (item.vcodec !== 'none' && item.acodec !== 'none')));
            candidates.sort((a, b) => (b.width || 0) * (b.height || 0) - (a.width || 0) * (a.height || 0));
            const selected = candidates[0];
            if (!selected?.url) continue;
            await assertPublicUrl(selected.url);
            const size = Number.isSafeInteger(selected.filesize) && (selected.filesize || 0) > 0 ? selected.filesize! : 0;
            const media = { url: selected.url, size, fSize: bytesToSize(size) };
            (selected.ext === 'mp4' ? videos : photos).push(media);
        }
        if (!photos.length && !videos.length) throw new AppError('Instagram media unavailable.', 404);
        return { thumbnail: photos[0]?.url || '', photos, videos };
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

        if (activeExtractions >= 1) throw new AppError('Instagram sedang sibuk. Coba lagi sebentar.', 503);
        activeExtractions++;
        try {
            try {
                return await this.getMediaInfoFromSnapInsta(url);
            } catch {
                try {
                    return await this.getMediaInfoFromYtDlp(url);
                } catch (error) {
                    const detail = error as { stderr?: string };
                    if ((error instanceof AppError && error.statusCode === 404) || /private|login required|not available to everyone|can't be seen by certain audiences|content isn't available/i.test(detail.stderr || '')) {
                        throw new AppError('Media Instagram tidak tersedia untuk akses publik.', 404);
                    }
                    throw new AppError('Gagal mengambil media Instagram. Coba lagi sebentar.', 502);
                }
            }
        } finally { activeExtractions--; }
    }
}
