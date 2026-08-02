import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';

interface BraveSearchResult {
  title: string;
  link: string;
  snippet: string;
  thumbnail?: string;
}

interface BraveSearchResponse {
  results: BraveSearchResult[];
  /** Brave does not return an estimated total result count. */
  totalResults: string;
  searchTime: number;
}

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
  thumbnail?: {
    src?: string;
  };
}

interface BraveSearchApiResponse {
  web?: {
    results?: BraveWebResult[];
  };
}

export class BraveService {
  public async search(query: string, num: number = 5): Promise<BraveSearchResponse> {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY || '';
    if (!apiKey) {
      throw new AppError('BRAVE_SEARCH_API_KEY is not configured.', 500);
    }

    if (!query || query.trim().length === 0) {
      throw new AppError('Search query is required.', 400);
    }

    if (!Number.isInteger(num) || num < 1) {
      throw new AppError('Parameter "num" must be a positive integer.', 400);
    }

    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(num, 20)));
    const startedAt = performance.now();

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': apiKey,
        },
      });
    } catch (error) {
      logger.error('Brave Search API request failed', { error });
      throw new AppError('Unable to reach Brave Search API.', 502);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      logger.error(`Brave Search API error: ${response.status} - ${errorBody}`);
      throw new AppError(`Brave Search API error: ${response.status}`, response.status);
    }

    const data = (await response.json()) as BraveSearchApiResponse;
    const results: BraveSearchResult[] = (data.web?.results || [])
      .filter((item) => item.title && item.url)
      .map((item) => ({
        title: item.title || '',
        link: item.url || '',
        snippet: item.description || '',
        thumbnail: item.thumbnail?.src,
      }));

    return {
      results,
      totalResults: String(results.length),
      searchTime: Math.round((performance.now() - startedAt) / 10) / 100,
    };
  }
}
