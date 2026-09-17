export interface BilibiliPage {
  cid: number;
  page: number;
  title: string;
  duration: number;
}

export interface BilibiliMedia {
  type: 'video' | 'audio' | 'muxed' | 'image' | 'gif';
  quality: number;
  label: string;
  url: string;
  backupUrls: string[];
  mimeType: string;
  codecs: string;
  bandwidth: number;
  width?: number;
  height?: number;
  size?: number;
  order?: number;
  duration?: number;
}

export interface BilibiliResult {
  id: string;
  aid: number;
  url: string;
  title: string;
  description: string;
  thumbnail: string;
  author: { id: number; name: string; avatar: string };
  uploaded: number;
  duration: number;
  page: number;
  cid: number;
  pages: BilibiliPage[];
  requestedQuality: number;
  availableQualities: number[];
  format: 'dash' | 'progressive';
  requiresMerge: boolean;
  media: BilibiliMedia[];
  headers: { Referer: string; 'User-Agent': string };
}

export interface BilibiliOpusResult {
  id: string;
  url: string;
  title: string;
  description: string;
  thumbnail: string;
  author: { id: number; name: string; avatar: string };
  uploaded: number;
  format: 'images';
  requiresMerge: false;
  media: BilibiliMedia[];
  headers: { Referer: string; 'User-Agent': string };
}
