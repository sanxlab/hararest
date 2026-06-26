import { execFile } from 'child_process';
import fs from 'fs';
import { config } from '../../config/default';
import { AppError } from '../../utils/AppError';
import { VideoInfo, YtDlpJSON } from './youtube.types';
import logger from '../../utils/logger';

interface YtDlpResult {
    stdout: string;
    stderr: string;
}

interface YtDlpCommandError extends Error {
    stdout?: string;
    stderr?: string;
}

const VIDEO_FORMAT = '18/b[height<=360]/bv*[height<=360]+ba/b';
const MAX_BUFFER = 1024 * 1024 * 10;

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

    async downloadVideo(url: string): Promise<string> {
        const ts = Date.now();
        const outputTemplate = `${this.tmpDir}/${ts}.%(ext)s`;

        try {
            const { stdout } = await this.runYtDlp([
                '-f',
                VIDEO_FORMAT,
                '-o',
                outputTemplate,
                '--merge-output-format',
                'mp4',
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
}
