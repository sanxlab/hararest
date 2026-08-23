import { execFile } from 'child_process';
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
const MAX_BUFFER = 1024 * 1024 * 50;

export class YoutubeService {
    private binPath: string;
    private cookiePath: string;
    private tmpDir: string;

    constructor() {
        this.binPath = config.youtube.binPath;
        this.cookiePath = config.youtube.cookiePath;
        this.tmpDir = config.youtube.tmpDir;

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

    private executeYtDlp(args: string[], useCookie: boolean): Promise<YtDlpResult> {
        const ytdlpArgs = useCookie ? ['--cookies', this.cookiePath, ...args] : args;

        return new Promise((resolve, reject) => {
            execFile(this.binPath, ytdlpArgs, { maxBuffer: MAX_BUFFER }, (error, stdout, stderr) => {
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

    private async runYtDlp(args: string[]): Promise<YtDlpResult> {
        const useCookie = this.hasCookieFile();

        try {
            return await this.executeYtDlp(args, useCookie);
        } catch (error) {
            if (!useCookie || !this.isHttp403(error)) {
                throw error;
            }

            logger.warn('yt-dlp returned HTTP 403 with cookies; retrying once without cookies.');
            return this.executeYtDlp(args, false);
        }
    }

    async getInfo(url: string): Promise<VideoInfo> {
        try {
            const { stdout } = await this.runYtDlp(['-j', url]);
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

            qualities.sort();

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
            logger.error('YTDL Info Error:', error);
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Failed to fetch video info: ${message}`, 500);
        }
    }

    async downloadVideo(url: string, quality?: string): Promise<string> {
        const ts = Date.now();
        const outputTemplate = `${this.tmpDir}/${ts}.%(ext)s`;
        const videoFormat = buildVideoFormat(quality);

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
                url,
            ]);

            const expectedFilename = `${this.tmpDir}/${ts}.mp4`;

            if (fs.existsSync(expectedFilename)) {
                return expectedFilename;
            }

            const match = stdout.match(/(?:Merging formats into|Destination: )"?(.*?)"?(\n|$)/);
            if (match && match[1]) {
                return match[1].trim();
            }

            throw new Error('Could not determine output filename');
        } catch (error) {
            logger.error('YTDL Download Error:', error);
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Failed to download video: ${message}`, 500);
        }
    }

    async downloadAudio(url: string): Promise<string> {
        const ts = Date.now();

        const outputTemplate = `${this.tmpDir}/${ts}.%(ext)s`;

        try {
            const { stdout } = await this.runYtDlp([
                '-f',
                'bestaudio/best',
                '-o',
                outputTemplate,
                '--extract-audio',
                '--audio-format',
                'mp3',
                url,
            ]);

            const expectedFilename = `${this.tmpDir}/${ts}.mp3`;

            if (fs.existsSync(expectedFilename)) {
                return expectedFilename;
            }

            const match = stdout.match(/(?:Merging formats into|Destination: )"?(.*?)"?(\n|$)/);
            if (match && match[1]) {
                return match[1].trim();
            }

            throw new Error('Could not determine output filename');
        } catch (error) {
            logger.error('YTDL Download Error:', error);
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Failed to download video: ${message}`, 500);
        }
    }

    async search(query: string, limit: number = 5): Promise<SearchResult[]> {
        try {
            const { stdout } = await this.runYtDlp([
                `ytsearch${limit}:${query}`,
                '--flat-playlist',
                '-j',
                '--no-warnings',
            ]);

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
            logger.error('YTDL Search Error:', error);
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`Failed to search YouTube: ${message}`, 500);
        }
    }
}
