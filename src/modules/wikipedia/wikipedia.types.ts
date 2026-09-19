export interface WikipediaSection {
  title: string;
  level: number;
  id: string | null;
  content: string;
}

export interface WikipediaArticle {
  source_url: string;
  title: string;
  language: string;
  summary: string;
  content: string;
  sections: WikipediaSection[];
  images: { url: string; alt: string }[];
  categories: string[];
}
