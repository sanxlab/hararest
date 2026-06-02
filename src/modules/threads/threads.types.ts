export type ThreadsMediaType = 'video' | 'gif' | 'image' | 'media';

export interface ThreadsMediaItem {
    index?: number;
    label?: string;
    media_type?: ThreadsMediaType;
    username?: string;
    caption?: string;
    thumbnail_url?: string;
    profile_picture_url?: string;
    download_url?: string;
    original_media_url?: string;
}

export interface ThreadsDownloadResult {
    source_url: string;
    threadster_url: string;
    scraped_at: string;
    count: number;
    items: ThreadsMediaItem[];
}
