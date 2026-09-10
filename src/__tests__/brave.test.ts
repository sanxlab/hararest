import { BraveService } from '../modules/brave/brave.service';

const service = new BraveService();
const originalKey = process.env.BRAVE_SEARCH_API_KEY;
let mockedFetch: jest.SpiedFunction<typeof fetch>;

beforeEach(() => {
  process.env.BRAVE_SEARCH_API_KEY = 'test-key';
  mockedFetch = jest.spyOn(global, 'fetch');
});
afterEach(() => {
  mockedFetch.mockRestore();
  if (originalKey === undefined) delete process.env.BRAVE_SEARCH_API_KEY;
  else process.env.BRAVE_SEARCH_API_KEY = originalKey;
});

it('validates input before checking API configuration', async () => {
  delete process.env.BRAVE_SEARCH_API_KEY;
  await expect(service.search(' ')).rejects.toMatchObject({ statusCode: 400 });
  await expect(service.search('test', 21)).rejects.toMatchObject({ statusCode: 400 });
  await expect(service.search('test')).rejects.toMatchObject({ statusCode: 500 });
  expect(mockedFetch).not.toHaveBeenCalled();
});

it('maps web results and bounds the upstream request duration', async () => {
  mockedFetch.mockResolvedValue(new Response(JSON.stringify({ web: { results: [{ title: 'Test', url: 'https://example.com', description: 'Result' }, null, { title: 'Missing URL' }] } })));
  const result = await service.search('hello', 2);
  expect(result.results).toEqual([{ title: 'Test', link: 'https://example.com', snippet: 'Result', thumbnail: undefined }]);
  const [url, options] = mockedFetch.mock.calls[0];
  expect((url as URL).searchParams.get('count')).toBe('2');
  expect(options?.signal).toBeInstanceOf(AbortSignal);
});

it.each([401, 403, 500])('maps upstream HTTP %s to a gateway error', async (status) => {
  mockedFetch.mockResolvedValue(new Response('error', { status }));
  await expect(service.search('test')).rejects.toMatchObject({ statusCode: 502 });
});

it('reports malformed upstream JSON', async () => {
  mockedFetch.mockResolvedValue(new Response('<html>error</html>'));
  await expect(service.search('test')).rejects.toMatchObject({ statusCode: 502 });
});
