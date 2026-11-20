export interface AvscanFrame {
  image_name: string;
  similarity: number;
  timestamp: string;
  thumb_url: string;
}

export interface AvscanWatchUrls {
  missav: string;
  javdb: string;
  javbus: string;
  avscan_direct: string;
}

export interface AvscanItem {
  video_code: string;
  best_similarity: number;
  best_timestamp: string;
  best_thumb: string;
  frames: AvscanFrame[];
  watch_urls: AvscanWatchUrls;
}

export interface AvscanSearchResult {
  results: AvscanItem[];
}
