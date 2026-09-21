import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import { readResponseText } from '../../utils/readResponse';

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
    if (!query || query.trim().length === 0) {
      throw new AppError('Search query is required.', 400);
    }

    if (!Number.isInteger(num) || num < 1 || num > 20) {
      throw new AppError('Parameter "num" must be an integer between 1 and 20.', 400);
    }

    const apiKey = process.env.BRAVE_SEARCH_API_KEY || '';
    if (!apiKey) {
      throw new AppError('BRAVE_SEARCH_API_KEY is not configured.', 500);
    }

    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(num));
    const startedAt = performance.now();

    let response: Response;
    try {
      response = await fetch(url, {
        signal: AbortSignal.timeout(15000),
        redirect: 'error',
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
      await response.body?.cancel();
      logger.error(`Brave Search API error: ${response.status}`);
      throw new AppError(`Brave Search API error: ${response.status}`, response.status === 429 ? 503 : 502);
    }

    let data: BraveSearchApiResponse;
    try {
      data = JSON.parse(await readResponseText(response)) as BraveSearchApiResponse;
      if (!data || (data.web?.results !== undefined && !Array.isArray(data.web.results))) throw new Error('Invalid results');
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('Brave Search API returned invalid JSON data.', 502);
    }
    const results: BraveSearchResult[] = (data.web?.results || [])
      .filter((item) => item && typeof item.title === 'string' && typeof item.url === 'string')
      .slice(0, num)
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
