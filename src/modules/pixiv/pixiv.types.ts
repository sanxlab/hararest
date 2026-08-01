export interface PixivDownload {
    id: string;
    title: string;
    description: string;
    author: string;
    urls: string[]; // List of original image URLs
}

export interface PixivSearchItem {
    id: string;
    title: string;
    url: string; // Thumbnail URL
    author: string;
}

export interface PixivSearchResponse {
    results: PixivSearchItem[];
}
