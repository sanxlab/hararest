export interface YtDlpJSON {
  id: string;
  title: string;
  description: string;
  duration: number;
  view_count: number;
  like_count: number;
  comment_count: number;
  upload_date: string;
  uploader: string;
  uploader_id: string;
  channel_id: string;
  channel_follower_count: number;
  channel_is_verified: boolean;
  formats: Format[];
  thumbnail: string;
}

export interface Format {
  format_id: string;
  ext: string;
  height: number;
  width: number;
  vcodec: string;
  acodec: string;
  filesize?: number;
}

export interface ChannelInfo {
  id: string;
  handle: string;
  name: string;
  subscribers: number;
  verified: boolean;
}

export interface VideoInfo {
  id: string;
  title: string;
  thumbnail: string;
  description: string;
  duration: number;
  views: number;
  likes: number;
  comments: number;
  uploaded: string;
  channel: ChannelInfo;
  videos: string[]; 
}

export interface SearchResult {
  id: string;
  title: string;
  thumbnail: string;
  duration: number;
  views: number;
  channel: {
    name: string;
    id: string;
  };
  url: string;
}
