export interface TwitterMediaLink {
    label: string;
    quality: string;
    url: string;
}

export interface TwitterDownloadResult {
    status: 'ok';
    input_url: string;
    downloader_url: string;
    media_links: TwitterMediaLink[];
}
