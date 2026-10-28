export interface PinterestDownload {
    title: string;
    description: string;
    author: string;
    url: string;
    type: 'image' | 'video';
}

export interface PinterestSearchItem {
    id: string;
    title: string;
    images: string[];
    author: string;
    link: string;
}

export interface PinterestSearchResponse {
    results: PinterestSearchItem[];
}

export interface PinterestUserProfile {
    username: string;
    fullName: string;
    bio?: string;
    avatar?: string;
    followers?: number;
    following?: number;
    pinsCount?: number;
    boardsCount?: number;
}

export interface PinterestUserResponse {
    user: PinterestUserProfile;
    pins: PinterestSearchItem[];
}
