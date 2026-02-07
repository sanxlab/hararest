import axios from 'axios';
import { AppError } from '../../utils/AppError';
import { TiktokDownload, TiktokUserFeed } from './tiktok.types';

export class TiktokService {
    private baseUrl = 'https://www.tikwm.com/api';

    public async download(url: string): Promise<TiktokDownload> {
        try {
            const { data } = await axios.post(`${this.baseUrl}/`, `url=${encodeURIComponent(url)}`);

            if ((data as any).code !== 0) {
                throw new Error((data as any).msg || 'Failed to download video');
            }

            const x = (data as any).data;
            return {
                id: x.id,
                region: x.region,
                title: x.title,
                cover: x.cover,
                duration: x.duration,
                size: x.size,
                video: x.images ? null : x.play,
                images: x.images || null,
                music: x.music,
                musicInfo: {
                    id: x.music_info.id,
                    name: x.music_info.title,
                    cover: x.music_info.cover,
                    author: x.music_info.author,
                    duration: x.music_info.duration
                },
                played: x.play_count,
                comments: x.comment_count,
                share: x.share_count,
                download: x.download_count,
                uploaded: x.create_time,
                author: {
                    id: x.author.id,
                    username: x.author.unique_id,
                    nickname: x.author.nickname,
                    avatar: x.author.avatar
                }
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`TikTok Download Error: ${message}`, 500);
        }
    }

    public async trendingFeed(region = 'US'): Promise<TiktokDownload[]> {
        try {
            const { data } = await axios.post(`${this.baseUrl}/feed/list`, `region=${encodeURIComponent(region)}`);

            if ((data as any).code !== 0) {
                throw new Error((data as any).msg || 'Failed to fetch trending feed');
            }

            return (data as any).data.map((x: any) => ({
                id: x.video_id,
                region: x.region,
                title: x.title,
                cover: x.cover,
                duration: x.duration,
                size: x.size,
                video: x.images ? null : x.play,
                images: x.images || null,
                music: x.music,
                musicInfo: {
                    id: x.music_info.id,
                    name: x.music_info.title,
                    cover: x.music_info.cover,
                    author: x.music_info.author,
                    duration: x.music_info.duration
                },
                played: x.play_count,
                comments: x.comment_count,
                share: x.share_count,
                download: x.download_count,
                uploaded: x.create_time,
                author: {
                    id: x.author.id,
                    username: x.author.unique_id,
                    nickname: x.author.nickname,
                    avatar: x.author.avatar
                }
            }));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`TikTok Trending Error: ${message}`, 500);
        }
    }

    public async userFeed(user: string, nextId?: string): Promise<TiktokUserFeed> {
        try {
            const cursor = nextId ? `&cursor=${nextId}` : '';
            const { data } = await axios.post(`${this.baseUrl}/user/posts`, `unique_id=${encodeURIComponent(user)}&count=15${cursor}`);

            if ((data as any).code !== 0) {
                throw new Error((data as any).msg || 'Failed to fetch user feed');
            }

            const lists = (data as any).data.videos.map((x: any) => ({
                id: x.video_id,
                region: x.region,
                title: x.title,
                cover: x.cover,
                duration: x.duration,
                size: x.size,
                video: x.images ? null : x.play,
                images: x.images || null,
                music: x.music,
                musicInfo: {
                    id: x.music_info.id,
                    name: x.music_info.title,
                    cover: x.music_info.cover,
                    author: x.music_info.author,
                    duration: x.music_info.duration
                },
                played: x.play_count,
                comments: x.comment_count,
                share: x.share_count,
                download: x.download_count,
                uploaded: x.create_time,
                author: {
                    id: x.author.id,
                    username: x.author.unique_id,
                    nickname: x.author.nickname,
                    avatar: x.author.avatar
                }
            }));

            return {
                lists,
                nextId: (data as any).data.cursor,
                next: (data as any).data.hasMore
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`TikTok User Feed Error: ${message}`, 500);
        }
    }

    public async search(query: string, nextId?: string): Promise<TiktokUserFeed> {
        try {
            const cursor = nextId ? `&cursor=${nextId}` : '';
            const { data } = await axios.post(`${this.baseUrl}/feed/search`, `keywords=${encodeURIComponent(query)}&count=15${cursor}`);

            if ((data as any).code !== 0) {
                throw new Error((data as any).msg || 'Failed to search videos');
            }

            const lists = (data as any).data.videos.map((x: any) => ({
                id: x.video_id,
                region: x.region,
                title: x.title,
                cover: x.cover,
                duration: x.duration,
                size: x.size,
                video: x.images ? null : x.play,
                images: x.images || null,
                music: x.music,
                musicInfo: {
                    id: x.music_info.id,
                    name: x.music_info.title,
                    cover: x.music_info.cover,
                    author: x.music_info.author,
                    duration: x.music_info.duration
                },
                played: x.play_count,
                comments: x.comment_count,
                share: x.share_count,
                download: x.download_count,
                uploaded: x.create_time,
                author: {
                    id: x.author.id,
                    username: x.author.unique_id,
                    nickname: x.author.nickname,
                    avatar: x.author.avatar
                }
            }));

            return {
                lists,
                nextId: (data as any).data.cursor,
                next: (data as any).data.hasMore
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`TikTok Search Error: ${message}`, 500);
        }
    }
}
