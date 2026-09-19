import axios from 'axios';
import * as cheerio from 'cheerio';
import { AppError } from '../../utils/AppError';
import { getPublicPage } from '../../utils/http';
import { WikipediaArticle, WikipediaSection } from './wikipedia.types';

function articleUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new AppError('Invalid Wikipedia URL.', 400);
  }
  if (!/^([a-z][a-z0-9-]*)(\.m)?\.wikipedia\.org$/.test(url.hostname)) {
    throw new AppError('Only Wikipedia article URLs are allowed.', 403);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new AppError('Invalid Wikipedia URL protocol, credentials, or port.', 400);
  }
  let title: string;
  try {
    title = decodeURIComponent(url.pathname.slice('/wiki/'.length));
  } catch {
    throw new AppError('Invalid Wikipedia article title.', 400);
  }
  if (!url.pathname.startsWith('/wiki/') || !title.trim()) {
    throw new AppError('URL must use the Wikipedia /wiki/Article format.', 400);
  }
  url.protocol = 'https:';
  url.hostname = url.hostname.replace('.m.wikipedia.org', '.wikipedia.org');
  url.search = '';
  url.hash = '';
  return url;
}

const cleanText = (text: string): string => text.replace(/\s+/g, ' ').trim();

export class WikipediaService {
  async scrape(input: string): Promise<WikipediaArticle> {
    const url = articleUrl(input);
    try {
      const response = await getPublicPage<string>(url.href, ['wikipedia.org'], {
        responseType: 'text',
        headers: {
          'User-Agent': 'Hararest/1.0 (Wikipedia article scraper)',
          Accept: 'text/html',
        },
      });
      return this.parse(response.data, url.href);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        throw new AppError('Wikipedia article not found.', 404);
      }
      throw new AppError('Failed to fetch Wikipedia article.', 502);
    }
  }

  parse(html: string, sourceUrl: string): WikipediaArticle {
    const $ = cheerio.load(html);
    const body = $('#mw-content-text .mw-parser-output, body > .mw-parser-output').first();
    const title = cleanText($('#firstHeading').text() || $('h1').first().text());
    if ($('.noarticletext, #noarticletext').length) {
      throw new AppError('Wikipedia article not found.', 404);
    }
    if (!title || !body.length) {
      throw new AppError('Wikipedia response does not contain an article.', 502);
    }

    const categories = $('#mw-normal-catlinks li a')
      .map((_, el) => cleanText($(el).text()))
      .get();
    body
      .find(
        'script, style, .mw-editsection, sup.reference, .hatnote, .navbox, .vertical-navbox, .sidebar, .ambox, .metadata, .toc, #toc, .reflist, .mw-references-wrap',
      )
      .remove();

    const images: WikipediaArticle['images'] = [];
    const seenImages = new Set<string>();
    body.find('img').each((_, el) => {
      const src = $(el).attr('src');
      if (!src) return;
      try {
        const imageUrl = new URL(src, sourceUrl);
        if (!['https:', 'http:'].includes(imageUrl.protocol) || seenImages.has(imageUrl.href))
          return;
        seenImages.add(imageUrl.href);
        images.push({ url: imageUrl.href, alt: cleanText($(el).attr('alt') || '') });
      } catch {
        /* Ignore malformed image URLs in upstream HTML. */
      }
    });

    body.find('table, figure, .thumb, .gallery').remove();
    body.find('br').replaceWith(' ');
    body.find('li, dt, dd, p').prepend(' ').append(' ');
    const lead: string[] = [];
    const blocks: string[] = [];
    const sections: WikipediaSection[] = [];
    let current: WikipediaSection | undefined;
    body.find('h2, h3, h4, h5, h6, p, ul, ol, dl, pre, blockquote').each((_, el) => {
      const node = $(el);
      if (node.parents('p, ul, ol, dl, pre, blockquote').length) return;
      const text = cleanText(node.text());
      if (!text) return;
      const tagName = String(node.prop('tagName')).toLowerCase();
      if (/^h[2-6]$/.test(tagName)) {
        current = {
          title: text,
          level: Number(tagName[1]),
          id: node.attr('id') || node.find('[id]').first().attr('id') || null,
          content: '',
        };
        sections.push(current);
      } else if (current) {
        current.content += `${current.content ? '\n\n' : ''}${text}`;
      } else {
        lead.push(text);
      }
      blocks.push(text);
    });
    if (!blocks.length) throw new AppError('Wikipedia article has no readable content.', 502);

    let canonical = sourceUrl;
    const canonicalHref = $('link[rel="canonical"]').attr('href');
    if (canonicalHref) {
      try {
        canonical = articleUrl(new URL(canonicalHref, sourceUrl).href).href;
      } catch {
        /* Keep the validated source URL. */
      }
    }
    return {
      source_url: canonical,
      title,
      language: $('html').attr('lang') || new URL(sourceUrl).hostname.split('.')[0],
      summary: lead.join('\n\n'),
      content: blocks.join('\n\n'),
      sections,
      images,
      categories,
    };
  }
}
