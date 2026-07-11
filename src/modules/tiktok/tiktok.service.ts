import axios from 'axios';
import { AppError } from '../../utils/AppError';
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
    music_info: TikwmMusicInfo;
    play_count: number;
    comment_count: number;
    share_count: number;
    download_count: number;
    create_time: number;
    author: TikwmAuthor;
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
    if (data.code !== 0) {
        throw new Error(data.msg || fallbackMessage);
    }

    return data.data;
};

const mapVideo = (video: TikwmVideo): TiktokDownload => ({
    id: video.id || video.video_id || '',
    region: video.region,
    title: video.title,
    cover: video.cover,
    duration: video.duration,
    size: video.size,
    video: video.images ? null : video.play,
    images: video.images || null,
    music: video.music,
    musicInfo: {
        id: video.music_info.id,
        name: video.music_info.title,
        cover: video.music_info.cover,
        author: video.music_info.author,
        duration: video.music_info.duration
    },
    played: video.play_count,
    comments: video.comment_count,
    share: video.share_count,
    download: video.download_count,
    uploaded: video.create_time,
    author: {
        id: video.author.id,
        username: video.author.unique_id,
        nickname: video.author.nickname,
        avatar: video.author.avatar
    }
});

export class TiktokService {
    private baseUrl = 'https://www.tikwm.com/api';

    public async download(url: string): Promise<TiktokDownload> {
        try {
            const { data } = await axios.post<TikwmResponse<TikwmVideo>>(
                `${this.baseUrl}/`,
                `url=${encodeURIComponent(url)}`
            );
            return mapVideo(assertSuccessfulResponse(data, 'Failed to download video'));
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`TikTok Download Error: ${message}`, 500);
        }
    }

    public async trendingFeed(region = 'US'): Promise<TiktokDownload[]> {
        try {
            const { data } = await axios.post<TikwmResponse<TikwmVideo[]>>(
                `${this.baseUrl}/feed/list`,
                `region=${encodeURIComponent(region)}`
            );
            return assertSuccessfulResponse(data, 'Failed to fetch trending feed').map(mapVideo);
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`TikTok Trending Error: ${message}`, 500);
        }
    }

    public async userFeed(user: string, nextId?: string): Promise<TiktokUserFeed> {
        try {
            const cursor = nextId ? `&cursor=${nextId}` : '';
            const { data } = await axios.post<TikwmResponse<TikwmFeedData>>(
                `${this.baseUrl}/user/posts`,
                `unique_id=${encodeURIComponent(user)}&count=15${cursor}`
            );
            const feed = assertSuccessfulResponse(data, 'Failed to fetch user feed');

            return {
                lists: feed.videos.map(mapVideo),
                nextId: feed.cursor,
                next: feed.hasMore
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`TikTok User Feed Error: ${message}`, 500);
        }
    }

    public async search(query: string, nextId?: string): Promise<TiktokUserFeed> {
        try {
            const cursor = nextId ? `&cursor=${nextId}` : '';
            const { data } = await axios.post<TikwmResponse<TikwmFeedData>>(
                `${this.baseUrl}/feed/search`,
                `keywords=${encodeURIComponent(query)}&count=15${cursor}`
            );
            const feed = assertSuccessfulResponse(data, 'Failed to search videos');

            return {
                lists: feed.videos.map(mapVideo),
                nextId: feed.cursor,
                next: feed.hasMore
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new AppError(`TikTok Search Error: ${message}`, 500);
        }
    }
}
