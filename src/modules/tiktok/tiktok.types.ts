export interface TiktokMusic {
    id: string;
    name: string;
    cover: string;
    author: string;
    duration: number;
}

export interface TiktokAuthor {
    id: string;
    username: string;
    nickname: string;
    avatar: string;
}

export interface TiktokDownload {
    id: string;
    region: string;
    title: string;
    cover: string;
    duration: number;
    size: number;
    video: string | null;
    images: string[] | null;
    music: string;
    musicInfo: TiktokMusic;
    played: number;
    comments: number;
    share: number;
    download: number;
    uploaded: number;
    author: TiktokAuthor;
}

export interface TiktokUserFeed {
    lists: TiktokDownload[];
    nextId: string;
    next: boolean;
}
