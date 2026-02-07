export interface InstagramMedia {
    url: string;
    size: number;
    fSize: string;
}

export interface InstagramMediaInfo {
    thumbnail: string;
    photos: InstagramMedia[];
    videos: InstagramMedia[];
}
