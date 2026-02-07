export interface FacebookVideo {
    quality: string;
    url: string;
    size: number;
    fSize: string;
}

export interface FacebookVideoInfo {
    thumbnail: string;
    videos: FacebookVideo[];
}
