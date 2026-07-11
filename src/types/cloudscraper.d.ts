declare module 'cloudscraper' {
  export interface CloudscraperRequestOptions {
    uri: string;
    headers: Record<string, string>;
    jar?: unknown;
    timeout?: number;
    form?: Record<string, string>;
  }

  export interface CloudscraperClient {
    jar: () => unknown;
    get: (options: CloudscraperRequestOptions) => Promise<unknown>;
    post: (options: CloudscraperRequestOptions) => Promise<unknown>;
  }

  const cloudscraper: CloudscraperClient;
  export default cloudscraper;
}
