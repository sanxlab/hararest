export interface PixivDownload {
    id: string;
    title: string;
    description: string;
    author: string;
    urls: string[]; // List of original image URLs
    nsfw?: boolean;
    xRestrict?: number;
    tags?: string[];
}

export interface PixivSearchItem {
    id: string;
    title: string;
    url: string; // Thumbnail URL
    author: string;
    nsfw?: boolean;
    xRestrict?: number;
    tags?: string[];
}

export interface PixivSearchResponse {
    results: PixivSearchItem[];
}

export interface PixivUserProfile {
    id: string;
    name: string;
    comment?: string;
    avatar?: string;
    premium?: boolean;
    twitterUrl?: string;
}

export interface PixivUserArtwork {
    id: string;
    title: string;
    url: string;
    nsfw: boolean;
    xRestrict: number;
    tags: string[];
    pageCount: number;
    width?: number;
    height?: number;
}

export interface PixivUserResponse {
    user: PixivUserProfile;
    artworks: PixivUserArtwork[];
}
