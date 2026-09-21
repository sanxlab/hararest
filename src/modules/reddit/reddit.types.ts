export interface RedditMedia {
  url: string;
  type: 'video' | 'audio' | 'image';
  format: string;
  quality: string;
  quality_number: number;
  requires_conversion: boolean;
  has_audio: boolean | null;
  audio_url: string | null;
  is_gif: boolean;
}

export interface RedditDownloadResult {
  source_url: string;
  resolved_url: string;
  provider: 'reddit';
  is_gallery: boolean;
  title: string;
  thumbnail: string | null;
  uploader: string;
  duration: number | null;
  download_url: string;
  requires_conversion: boolean;
  count: number;
  media: RedditMedia[];
}
