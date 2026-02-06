import { exec } from 'child_process';
import util from 'util';
import fs from 'fs';
import { config } from '../../config/default';
import { AppError } from '../../utils/AppError';
import { VideoInfo, YtDlpJSON } from './youtube.types';
import logger from '../../utils/logger';

const execPromise = util.promisify(exec);

export class YoutubeService {
    private binPath: string;
    private cookiePath: string;
    private tmpDir: string;
    private extractorArgs = 'youtube:player-client=default,mweb';

    constructor() {
        this.binPath = config.youtube.binPath;
        this.cookiePath = config.youtube.cookiePath;
        this.tmpDir = config.youtube.tmpDir;

        // Ensure tmp dir exists
        if (!fs.existsSync(this.tmpDir)) {
            fs.mkdirSync(this.tmpDir, { recursive: true });
        }
    }

    async getInfo(url: string): Promise<VideoInfo> {
        const cmd = `${this.binPath} --cookies ${this.cookiePath} -j "${url}"`;

        try {
            const { stdout } = await execPromise(cmd, { maxBuffer: 1024 * 1024 * 10 }); // Increase buffer for large JSON
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

    async downloadVideo(url: string, quality: string = '480p'): Promise<string> {
        const heightVal = quality.replace('p', '');
        const ts = Date.now();

        const formatSelector = `bv[height=${heightVal}]+ba/b[height=${heightVal}]/b`;
        const outputTemplate = `${this.tmpDir}/${ts}.%(ext)s`;

        const cmd = `${this.binPath} --cookies ${this.cookiePath} -f "${formatSelector}" -o "${outputTemplate}" --merge-output-format mp4 "${url}"`;

        try {
            const { stdout } = await execPromise(cmd);

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

        const cmd = `${this.binPath} --cookies ${this.cookiePath} -f "bestaudio/best" -o "${outputTemplate}" --extract-audio --audio-format mp3 "${url}"`;

        try {
            const { stdout } = await execPromise(cmd);

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
