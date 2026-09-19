import axios from 'axios';
import supertest from 'supertest';
import app from '../app';
import { WikipediaService } from '../modules/wikipedia/wikipedia.service';

jest.mock('axios');
const get = axios.get as jest.Mock;
const service = new WikipediaService();
const fixture = `<!doctype html><html lang="en"><head>
  <link rel="canonical" href="https://en.wikipedia.org/wiki/Wiki">
</head><body><h1 id="firstHeading"><span class="mw-parser-output">Wiki</span></h1>
<div id="mw-content-text"><div class="mw-parser-output">
  <div class="hatnote">Not article content</div>
  <table class="infobox"><tr><td>Sidebar<img src="//upload.wikimedia.org/wiki.png" alt="Wiki image"></td></tr></table>
  <p>A <b>wiki</b> is editable.<sup class="reference">[1]</sup></p><p>Second paragraph.</p>
  <div class="mw-heading"><h2 id="History">History</h2><span class="mw-editsection">[edit]</span></div>
  <p>First wiki.</p><h3><span id="Editing" class="mw-headline">Editing</span></h3>
  <ul><li>One</li><li>Two<p>Nested text.</p></li></ul>
  <div class="reflist">Citation noise</div><div class="navbox">Navigation noise</div>
</div></div><div id="mw-normal-catlinks"><ul><li><a>Wikis</a></li></ul></div></body></html>`;

beforeEach(() => {
  get.mockReset();
  get.mockResolvedValue({ status: 200, data: fixture, headers: {} });
});

it('extracts article content without heading markup, navigation, or reference markers', async () => {
  const response = await supertest(app)
    .get('/api/wikipedia/scrape')
    .query({ url: 'https://en.wikipedia.org/wiki/Wiki' });
  expect(response.status).toBe(200);
  expect(response.body.status).toBe('success');
  expect(response.body.data).toMatchObject({
    title: 'Wiki',
    language: 'en',
    source_url: 'https://en.wikipedia.org/wiki/Wiki',
    summary: 'A wiki is editable.\n\nSecond paragraph.',
    categories: ['Wikis'],
    images: [{ url: 'https://upload.wikimedia.org/wiki.png', alt: 'Wiki image' }],
    sections: [
      { title: 'History', level: 2, id: 'History', content: 'First wiki.' },
      { title: 'Editing', level: 3, id: 'Editing', content: 'One Two Nested text.' },
    ],
  });
  expect(response.body.data.content).not.toMatch(/noise|\[edit\]|\[1\]|Sidebar|Not article/);
});

it.each([
  [undefined, 400],
  ['', 400],
  ['not-a-url', 400],
  ['https://example.com/wiki/Wiki', 403],
  ['https://en.wikipedia.org.evil.com/wiki/Wiki', 403],
  ['ftp://en.wikipedia.org/wiki/Wiki', 400],
  ['https://user:pass@en.wikipedia.org/wiki/Wiki', 400],
  ['https://en.wikipedia.org:8443/wiki/Wiki', 400],
  ['https://en.wikipedia.org/w/index.php', 400],
  ['https://en.wikipedia.org/wiki/', 400],
  ['https://en.wikipedia.org/wiki/%ZZ', 400],
])('rejects invalid input %s', async (url, status) => {
  const response = await supertest(app)
    .get('/api/wikipedia/scrape')
    .query(url === undefined ? {} : { url });
  expect(response.status).toBe(status);
  expect(get).not.toHaveBeenCalled();
});

it('rejects repeated query parameters', async () => {
  const response = await supertest(app).get('/api/wikipedia/scrape?url=a&url=b');
  expect(response.status).toBe(400);
  expect(get).not.toHaveBeenCalled();
});

it('normalizes mobile URLs and supports other languages', async () => {
  get.mockResolvedValue({
    status: 200,
    headers: {},
    data: fixture.replace('lang="en"', 'lang="id"'),
  });
  const result = await service.scrape('http://id.m.wikipedia.org/wiki/Wiki?oldid=123#History');
  expect(get.mock.calls[0][0]).toBe('https://id.wikipedia.org/wiki/Wiki');
  expect(result.language).toBe('id');
});

it('blocks redirects outside Wikipedia before fetching the target', async () => {
  get.mockResolvedValueOnce({
    status: 302,
    headers: { location: 'https://example.com/wiki/Wiki' },
  });
  await expect(service.scrape('https://en.wikipedia.org/wiki/Wiki')).rejects.toMatchObject({
    statusCode: 403,
  });
  expect(get).toHaveBeenCalledTimes(1);
});

it.each([404, 429, 500])('maps upstream HTTP %s', async (status) => {
  (axios.isAxiosError as unknown as jest.Mock).mockReturnValue(true);
  get.mockRejectedValue({ response: { status } });
  await expect(service.scrape('https://en.wikipedia.org/wiki/Wiki')).rejects.toMatchObject({
    statusCode: status === 404 ? 404 : 502,
  });
});

it('reports timeouts as gateway errors', async () => {
  get.mockRejectedValue(new Error('timeout'));
  await expect(service.scrape('https://en.wikipedia.org/wiki/Wiki')).rejects.toMatchObject({
    statusCode: 502,
  });
});

it('rejects missing articles and unexpected upstream markup', () => {
  expect(() =>
    service.parse('<div class="noarticletext"></div>', 'https://en.wikipedia.org/wiki/Missing'),
  ).toThrow('Wikipedia article not found');
  expect(() =>
    service.parse('<html>Unavailable</html>', 'https://en.wikipedia.org/wiki/Wiki'),
  ).toThrow('does not contain an article');
});
