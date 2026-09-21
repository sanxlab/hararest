import axios from 'axios';
import { AppError } from '../../utils/AppError';
import { publicHttpAgent, publicHttpsAgent } from '../../utils/publicAgent';
import { TiktokDownload, TiktokUserFeed } from './tiktok.types';

interface TikwmMusicInfo {
    id: string;
    title: string;
    cover: string;
    author: string;
    duration: number;
}

interface TikwmAuthor {
    id: string;
    unique_id: string;
    nickname: string;
    avatar: string;
}

interface TikwmVideo {
    id?: string;
    video_id?: string;
    region: string;
    title: string;
    cover: string;
    duration: number;
    size: number;
    play: string;
    images?: string[];
    music: string;
    music_info?: TikwmMusicInfo;
    play_count: number;
    comment_count: number;
    share_count: number;
    download_count: number;
    create_time: number;
    author?: TikwmAuthor;
}

interface TikwmFeedData {
    videos: TikwmVideo[];
    cursor: string;
    hasMore: boolean;
}

interface TikwmResponse<T> {
    code: number;
    msg?: string;
    data: T;
}

const assertSuccessfulResponse = <T>(data: TikwmResponse<T>, fallbackMessage: string): T => {
    if (!data || data.code !== 0 || data.data == null) {
        throw new Error(data?.msg || fallbackMessage);
    }

    return data.data;
};

const upstreamError = (operation: string, error: unknown): AppError => {
    const status = typeof error === 'object' && error !== null
        ? (error as { response?: { status?: unknown } }).response?.status : undefined;
    const suffix = typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? ` (HTTP ${status})` : '';
    return new AppError(`TikTok ${operation} request failed${suffix}.`, 502);
};

const mapVideo = (video: TikwmVideo): TiktokDownload => ({
    id: video.id || video.video_id || '',
    region: video.region,
    title: video.title,
    cover: video.cover,
    duration: video.duration,
    size: video.size,
    video: video.images?.length ? null : video.play,
    images: video.images?.length ? video.images : null,
    music: video.music,
    musicInfo: {
        id: video.music_info?.id ?? '',
        name: video.music_info?.title ?? '',
        cover: video.music_info?.cover ?? '',
        author: video.music_info?.author ?? '',
        duration: video.music_info?.duration ?? 0
    },
    played: video.play_count,
    comments: video.comment_count,
    share: video.share_count,
    download: video.download_count,
    uploaded: video.create_time,
    author: {
        id: video.author?.id ?? '',
        username: video.author?.unique_id ?? '',
        nickname: video.author?.nickname ?? '',
        avatar: video.author?.avatar ?? ''
    }
});

export class TiktokService {
    private baseUrl = 'https://www.tikwm.com/api';
    private readonly requestOptions = {
        timeout: 30000,
        maxRedirects: 0,
        maxContentLength: 5 * 1024 * 1024,
        proxy: false as const,
        httpAgent: publicHttpAgent,
        httpsAgent: publicHttpsAgent
    };

    public async download(url: string): Promise<TiktokDownload> {
        try {
            const { data } = await axios.post<TikwmResponse<TikwmVideo>>(
                `${this.baseUrl}/`,
                `url=${encodeURIComponent(url)}`,
                this.requestOptions
            );
            return mapVideo(assertSuccessfulResponse(data, 'Failed to download video'));
        } catch (error) {
            throw upstreamError('download', error);
        }
    }

    public async trendingFeed(region = 'US'): Promise<TiktokDownload[]> {
        try {
            const { data } = await axios.post<TikwmResponse<TikwmVideo[]>>(
                `${this.baseUrl}/feed/list`,
                `region=${encodeURIComponent(region)}`,
                this.requestOptions
            );
            return assertSuccessfulResponse(data, 'Failed to fetch trending feed').map(mapVideo);
        } catch (error) {
            throw upstreamError('trending', error);
        }
    }

    public async userFeed(user: string, nextId?: string): Promise<TiktokUserFeed> {
        try {
            const cursor = nextId ? `&cursor=${encodeURIComponent(nextId)}` : '';
            const { data } = await axios.post<TikwmResponse<TikwmFeedData>>(
                `${this.baseUrl}/user/posts`,
                `unique_id=${encodeURIComponent(user)}&count=15${cursor}`,
                this.requestOptions
            );
            const feed = assertSuccessfulResponse(data, 'Failed to fetch user feed');

            return {
                lists: feed.videos.map(mapVideo),
                nextId: feed.cursor,
                next: feed.hasMore
            };
        } catch (error) {
            throw upstreamError('user feed', error);
        }
    }

    public async search(query: string, nextId?: string): Promise<TiktokUserFeed> {
        try {
            const cursor = nextId ? `&cursor=${encodeURIComponent(nextId)}` : '';
            const { data } = await axios.post<TikwmResponse<TikwmFeedData>>(
                `${this.baseUrl}/feed/search`,
                `keywords=${encodeURIComponent(query)}&count=15${cursor}`,
                this.requestOptions
            );
            const feed = assertSuccessfulResponse(data, 'Failed to search videos');

            return {
                lists: feed.videos.map(mapVideo),
                nextId: feed.cursor,
                next: feed.hasMore
            };
        } catch (error) {
            throw upstreamError('search', error);
        }
    }
}
