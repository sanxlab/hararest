export interface XiaohongshuAuthor {
    id: string;
    name: string;
    avatar: string;
}

export interface XiaohongshuTag {
    id: string;
    name: string;
}

export interface XiaohongshuImage {
    url: string;
    width: number;
    height: number;
    livePhoto: boolean;
}

export interface XiaohongshuVideo {
    width: number;
    height: number;
    bitrate: number;
    duration: number;
    size: number;
    url: string;
}

export interface XiaohongshuResult {
    id: string;
    uploaded: number;
    type: 'video' | 'normal';
    title: string;
    description: string;
    author: XiaohongshuAuthor;
    tags: XiaohongshuTag[];
    liked: string;
    saved: string;
    share: string;
    comments: number;
    recommended: string;
    cover: string | null;
    images: XiaohongshuImage[];
    video: XiaohongshuVideo | null;
}
