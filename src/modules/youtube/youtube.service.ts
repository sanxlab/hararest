import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChildProcess, execFile } from 'child_process';
import fs from 'fs';
import { config } from '../../config/default';
import { AppError } from '../../utils/AppError';
import { VideoInfo, YtDlpJSON, SearchResult } from './youtube.types';
import logger from '../../utils/logger';

interface YtDlpResult {
    stdout: string;
    stderr: string;
}

interface YtDlpCommandError extends Error {
    stdout?: string;
    stderr?: string;
}

const DEFAULT_VIDEO_FORMAT = '18/b[height<=360]/bv*[height<=360]+ba/b';

function buildVideoFormat(quality?: string): string {
    if (!quality) return DEFAULT_VIDEO_FORMAT;
    const h = parseInt(quality.replace('p', ''), 10);
    if (isNaN(h) || h <= 0) return DEFAULT_VIDEO_FORMAT;
    return `bv*[height<=${h}][ext=mp4]+ba/b[height<=${h}]/bv*[height<=${h}]+ba/18/${DEFAULT_VIDEO_FORMAT}`;
}
const MAX_BUFFER = 8 * 1024 * 1024;
export const YOUTUBE_LIMITS = { concurrency: config.youtube.concurrency, maxFileBytes: 256 * 1024 * 1024 };
// Shared by legacy routes, queued jobs, and player service instances.
let activeExtractions = 0;

export class YoutubeService {
    private binPath: string;
    private cookiePath: string;
    private tmpDir: string;

    constructor(tmpDir = config.youtube.tmpDir) {
        this.binPath = config.youtube.binPath;
        this.cookiePath = config.youtube.cookiePath;
        this.tmpDir = path.resolve(tmpDir);

        if (!fs.existsSync(this.tmpDir)) {
            fs.mkdirSync(this.tmpDir, { recursive: true });
        }
    }

    private hasCookieFile(): boolean {
        try {
            const cookieFile = fs.statSync(this.cookiePath);
            return cookieFile.isFile() && cookieFile.size > 0;
        } catch {
            return false;
        }
    }

    private async executeYtDlp(args: string[], useCookie: boolean, signal?: AbortSignal): Promise<YtDlpResult> {
        const runtimeArgs = ['--js-runtimes', 'node', ...args];
        if (config.youtube.potProviderUrl) {
            runtimeArgs.unshift('--extractor-args', `youtubepot-bgutilhttp:base_url=${config.youtube.potProviderUrl}`);
        }
        const ytdlpArgs = useCookie ? ['--cookies', this.cookiePath, ...runtimeArgs] : runtimeArgs;

        let child: ChildProcess | undefined;
        const output = new Promise<YtDlpResult>((resolve, reject) => {
            child = execFile(this.binPath, ytdlpArgs, { maxBuffer: MAX_BUFFER, timeout: 9 * 60 * 1000, killSignal: 'SIGKILL', signal }, (error, stdout, stderr) => {
                if (error) {
                    const commandError = error as YtDlpCommandError;
                    commandError.stdout = stdout;
                    commandError.stderr = stderr;
                    reject(commandError);
                    return;
                }

                resolve({ stdout, stderr });
            });
        });
        try {
            return await output;
        } finally {
            // Abort can invoke execFile's callback before the killed child exits.
            // Retain the shared process slot until the operating system reaps it.
            if (child && child.exitCode === null && child.signalCode === null) {
                await new Promise<void>(resolve => child!.once('close', () => resolve()));
            }
        }
    }

    private isHttp403(error: unknown): boolean {
        if (!(error instanceof Error)) {
            return false;
        }

        const commandError = error as YtDlpCommandError;
        const output = [commandError.message, commandError.stdout, commandError.stderr]
            .filter((value): value is string => typeof value === 'string')
            .join('\n');

        return /\b403\b/.test(output);
    }

    private async runYtDlp(args: string[], signal?: AbortSignal): Promise<YtDlpResult> {
        signal?.throwIfAborted();
        if (activeExtractions >= YOUTUBE_LIMITS.concurrency) {
            throw new AppError('YouTube extractor is busy. Try again shortly.', 503);
        }
        activeExtractions++;
        try {
            const useCookie = this.hasCookieFile();
            try {
                return await this.executeYtDlp(args, useCookie, signal);
            } catch (error) {
                if (signal?.aborted || !useCookie || !this.isHttp403(error)) {
                    throw error;
                }

                logger.warn('yt-dlp returned HTTP 403 with cookies; retrying once without cookies.');
                return await this.executeYtDlp(args, false, signal);
            }
        } finally {
            activeExtractions--;
        }
    }

    async getInfo(url: string, signal?: AbortSignal): Promise<VideoInfo> {
        try {
            const { stdout } = await this.runYtDlp(['--no-playlist', '--playlist-end', '1', '-j', '--', url], signal);
            const rawInfo: YtDlpJSON = JSON.parse(stdout);

            const qualityMap = new Set<string>();
            const qualities: string[] = [];

            if (rawInfo.formats) {
                rawInfo.formats.forEach((f) => {
                    if (f.ext === 'mp4' && f.height > 0) {
                        const q = `${f.height}p`;
                        if (!qualityMap.has(q)) {
                            qualityMap.add(q);
                            qualities.push(q);
                        }
                    }
                });
            }

            qualities.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

            return {
                id: rawInfo.id,
                title: rawInfo.title,
                thumbnail: `https://i.ytimg.com/vi/${rawInfo.id}/maxresdefault.jpg`,
                description: rawInfo.description,
                duration: rawInfo.duration,
                views: rawInfo.view_count,
                likes: rawInfo.like_count,
                comments: rawInfo.comment_count,
                uploaded: rawInfo.upload_date,
                channel: {
                    id: rawInfo.channel_id,
                    handle: rawInfo.uploader_id,
                    name: rawInfo.uploader,
                    subscribers: rawInfo.channel_follower_count,
                    verified: rawInfo.channel_is_verified,
                },
                videos: qualities,
            };
        } catch (error) {
            if (error instanceof AppError) throw error;
            logger.error('YTDL info failed');
            throw new AppError('Failed to fetch video info.', 500);
        }
    }

    async downloadVideo(url: string, quality?: string, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<string> {
        const ts = randomUUID();
        const outputTemplate = `${this.tmpDir}/${ts}.%(ext)s`;
        const videoFormat = buildVideoFormat(quality);
        const maxBytes = this.downloadLimit(options.maxBytes);

        try {
            const { stdout } = await this.runYtDlp([
                '-f',
                videoFormat,
                '-o',
                outputTemplate,
                '--merge-output-format',
                'mp4',
                '--recode-video',
                'mp4',
                '--postprocessor-args',
                'ffmpeg:-c:v libx264 -profile:v main -level 3.1 -preset veryfast -crf 23 -pix_fmt yuv420p -c:a aac -b:a 128k -movflags +faststart',
                '--no-playlist',
                '--playlist-end', '1',
                '--print', 'after_move:filepath',
                '--max-filesize', String(maxBytes),
                '--', url,
            ], options.signal);

            const expectedFilename = `${this.tmpDir}/${ts}.mp4`;

            const finalPath = stdout.trim().split('\n').at(-1)?.trim();
            if (finalPath && path.resolve(finalPath) === expectedFilename && fs.existsSync(finalPath)) {
                await this.validateDownload(finalPath, maxBytes);
                return path.resolve(finalPath);
            }

            throw new Error('Could not determine output filename');
        } catch (error) {
            await this.cleanupDownload(ts);
            if (error instanceof AppError) throw error;
            logger.error('YTDL download failed');
            throw new AppError('Failed to download media.', 500);
        }
    }

    async downloadAudio(url: string, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<string> {
        const ts = randomUUID();

        const outputTemplate = `${this.tmpDir}/${ts}.%(ext)s`;
        const maxBytes = this.downloadLimit(options.maxBytes);

        try {
            const { stdout } = await this.runYtDlp([
                '-f',
                'bestaudio/best',
                '-o',
                outputTemplate,
                '--extract-audio',
                '--audio-format',
                'mp3',
                '--no-playlist',
                '--playlist-end', '1',
                '--print', 'after_move:filepath',
                '--max-filesize', String(maxBytes),
                '--', url,
            ], options.signal);

            const expectedFilename = `${this.tmpDir}/${ts}.mp3`;

            const finalPath = stdout.trim().split('\n').at(-1)?.trim();
            if (finalPath && path.resolve(finalPath) === expectedFilename && fs.existsSync(finalPath)) {
                await this.validateDownload(finalPath, maxBytes);
                return path.resolve(finalPath);
            }

            throw new Error('Could not determine output filename');
        } catch (error) {
            await this.cleanupDownload(ts);
            if (error instanceof AppError) throw error;
            logger.error('YTDL download failed');
            throw new AppError('Failed to download media.', 500);
        }
    }

    private downloadLimit(maxBytes = YOUTUBE_LIMITS.maxFileBytes): number {
        if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > YOUTUBE_LIMITS.maxFileBytes) {
            throw new AppError('Invalid download size limit.', 400);
        }
        return maxBytes;
    }

    private async validateDownload(file: string, maxBytes: number): Promise<void> {
        const info = await fs.promises.stat(file);
        if (!info.isFile() || info.size <= 0 || info.size > maxBytes) {
            throw new AppError('Downloaded media is empty or exceeds the size limit.', 413);
        }
    }

    private async cleanupDownload(id: string): Promise<void> {
        try {
            const names = await fs.promises.readdir(this.tmpDir);
            await Promise.all(names.filter(name => name.startsWith(`${id}.`))
                .map(name => fs.promises.rm(path.join(this.tmpDir, name), { force: true })));
        } catch {
            logger.warn('Failed to clean up partial download');
        }
    }

    async search(query: string, limit: number = 5, signal?: AbortSignal): Promise<SearchResult[]> {
        if (!query.trim() || !Number.isInteger(limit) || limit < 1 || limit > 10) {
            throw new AppError('Search requires a query and an integer limit between 1 and 10.', 400);
        }
        try {
            const { stdout } = await this.runYtDlp([
                `ytsearch${limit}:${query}`,
                '--flat-playlist',
                '-j',
                '--no-warnings',
            ], signal);

            const results: SearchResult[] = stdout
                .trim()
                .split('\n')
                .filter((line) => line.trim())
                .map((line) => {
                    const raw = JSON.parse(line);
                    return {
                        id: raw.id,
                        title: raw.title,
                        thumbnail: raw.thumbnails?.[raw.thumbnails.length - 1]?.url || `https://i.ytimg.com/vi/${raw.id}/hqdefault.jpg`,
                        duration: raw.duration || 0,
                        views: raw.view_count || 0,
                        channel: {
                            name: raw.channel || raw.uploader || '',
                            id: raw.channel_id || '',
                        },
                        url: raw.url || `https://www.youtube.com/watch?v=${raw.id}`,
                    };
                });

            return results;
        } catch (error) {
            if (error instanceof AppError) throw error;
            logger.error('YTDL search failed');
            throw new AppError('Failed to search YouTube.', 500);
        }
    }
}
