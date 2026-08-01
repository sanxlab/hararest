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
