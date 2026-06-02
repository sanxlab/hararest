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

export interface InstagramStalkerOptions {
    targetUsername: string;
    includePosts?: boolean;
    includeReels?: boolean;
    includeAbout?: boolean;
    maxItems?: number | null;
    maxPages?: number | null;
    delayMs?: number;
    jitterMs?: number;
    maxRetries?: number;
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    backoffJitterMs?: number;
    timeoutMs?: number;
    profileOnlyOnRateLimit?: boolean;
    warmupDelayMs?: number;
    warmupJitterMs?: number;
    headful?: boolean;
}

export interface InstagramStalkerProfile {
    id: string;
    username: string;
    full_name: string;
    biography: string;
    external_url: string;
    is_private: boolean;
    is_verified: boolean;
    is_business_account: boolean;
    followers_count: number;
    following_count: number;
    posts_count: number;
    profile_pic_url: string;
}

export interface InstagramStalkerAboutAccount {
    available: boolean;
    date_joined: string | null;
    account_based_in: string | null;
    shared_followers_count: number | null;
    verified_since: string | null;
    is_verified: boolean;
    show_account_transparency_details: boolean;
    transparency_product_enabled: boolean;
    transparency_label: string | null;
    mutual_followers_count: number | null;
    profile_context_mutual_follow_ids: string[];
    source: {
        users_info_endpoint: boolean;
        about_dialog_scrape: boolean;
    };
}

export interface InstagramStalkerMediaItem {
    id: string;
    pk: string;
    shortcode: string;
    permalink: string;
    product_type: string;
    media_type: number;
    is_video: boolean;
    is_reel: boolean;
    taken_at_utc: string;
    like_count: number;
    comment_count: number;
    play_count: number | null;
    view_count: number | null;
    caption: string;
    caption_preview: string;
    thumbnail_url: string;
    video_url: string;
    carousel_media: Array<{
        id: string;
        media_type: number;
        is_video: boolean;
        image_url: string;
        video_url: string;
    }>;
}

export interface InstagramStalkerResult {
    status: 'ok';
    include: {
        about_account: boolean;
        posts: boolean;
        reels: boolean;
    };
    auth: {
        method: string;
        viewer_username: string;
        has_sessionid: boolean;
        cookie_file_loaded: string;
        cookie_file_imported_count: number;
    };
    target_username: string;
    profile: InstagramStalkerProfile;
    warnings: string[];
    about_account?: InstagramStalkerAboutAccount;
    posts_count?: number;
    posts?: InstagramStalkerMediaItem[];
    reels_count?: number;
    reels?: InstagramStalkerMediaItem[];
    all_posts_count?: number;
}
