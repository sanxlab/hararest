export type TwitterMediaType = 'video' | 'audio' | 'image';

export interface TwitterMediaLink {
    label: string;
    quality: string;
    media_type: TwitterMediaType;
    url: string;
}

export interface TwitterDownloadResult {
    status: 'ok';
    input_url: string;
    search_url: string;
    media_links: TwitterMediaLink[];
}
