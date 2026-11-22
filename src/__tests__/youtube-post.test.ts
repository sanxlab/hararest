import supertest from 'supertest';
import app from '../app';
import { getPublicPage } from '../utils/http';
import { getYoutubePost, parseYoutubePost, youtubePostId } from '../modules/youtube/youtube.post';

jest.mock('../utils/http', () => ({ getPublicPage: jest.fn() }));
const mockPage = getPublicPage as jest.Mock;
const id = 'UgkxThicaK5068CU3syx8JA0BFhKqE5OgZa3';
const image = (name: string) => ({ backstageImageRenderer: { image: { thumbnails: [
  { url: `https://yt3.ggpht.com/${name}=s288-c-fcrop64=1,0000ffff`, width: 288, height: 288 },
  { url: `https://yt3.ggpht.com/${name}=s736-c-fcrop64=1,0000ffff`, width: 736, height: 736 },
] } } });
function page(overrides = {}, otherPost?: object): string {
  return `<script>var ytInitialData = ${JSON.stringify({ contents: [otherPost, { backstagePostThreadRenderer: {
    post: { backstagePostRenderer: { postId: id, authorText: { simpleText: 'Author' },
      contentText: { runs: [{ text: 'Caption with } brace and " quote 🫪' }] },
      backstageAttachment: { postMultiImageRenderer: { images: Array.from({ length: 10 }, (_, i) => image(`image${i}`)) } },
      ...overrides,
    } },
  } }] })}; window.after = true;</script>`;
}

it('returns the exact requested post with ten ordered original images, ignoring other posts and avatars', () => {
  const result = parseYoutubePost(page({}, { backstagePostRenderer: { postId: 'other', backstageAttachment: image('wrong') } }), id);
  expect(result).toMatchObject({ id, author: 'Author', text: 'Caption with } brace and " quote 🫪' });
  expect(result.photos.map(photo => photo.url)).toEqual(Array.from({ length: 10 }, (_, i) => `https://yt3.ggpht.com/image${i}=s0`));
});

it('supports single images and attached videos without treating video thumbnails as photos', () => {
  expect(parseYoutubePost(page({ backstageAttachment: image('single') }), id).photos).toEqual([{ url: 'https://yt3.ggpht.com/single=s0' }]);
  expect(parseYoutubePost(page({ backstageAttachment: { videoRenderer: { videoId: 'dQw4w9WgXcQ' } } }), id)).toMatchObject({ photos: [], videoUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
});

it.each([
  ['missing post', '<script>var ytInitialData = {};</script>', 404],
  ['malformed JSON', '<script>var ytInitialData = {bad};</script>', 404],
  ['poll', page({ backstageAttachment: { pollRenderer: {} } }), 422],
  ['private image URL', page({ backstageAttachment: { backstageImageRenderer: { image: { thumbnails: [{ url: 'http://127.0.0.1/internal' }] } } } }), 422],
  ['too many photos', page({ backstageAttachment: { postMultiImageRenderer: { images: Array.from({ length: 21 }, () => image('extra')) } } }), 422],
])('rejects %s', (_name, html, statusCode) => {
  expect(() => parseYoutubePost(html as string, id)).toThrow(expect.objectContaining({ statusCode }));
});

it.each(['https://evil.example/post/' + id, 'https://youtube.com.evil.example/post/' + id,
  'https://user:pass@youtube.com/post/' + id, 'https://youtube.com:8443/post/' + id,
  'https://youtube.com/watch?v=x', 'https://youtube.com/post/invalid'])('rejects invalid URL %s', url => {
  expect(() => youtubePostId(url)).toThrow(expect.objectContaining({ statusCode: 400 }));
});

it('strips tracking query parameters and exposes the post route', async () => {
  mockPage.mockResolvedValue({ data: page() });
  const url = `https://m.youtube.com/post/${id}?surface=shorts&data=tracking`;
  expect((await getYoutubePost(url)).photos).toHaveLength(10);
  expect(mockPage).toHaveBeenLastCalledWith(`https://www.youtube.com/post/${id}?hl=en`, ['youtube.com'], expect.any(Object));
  const response = await supertest(app).get('/api/youtube/post').query({ url });
  expect(response.status).toBe(200);
  expect(response.body.data.photos).toHaveLength(10);
});

it('returns a safe upstream error', async () => {
  mockPage.mockRejectedValue(new Error('secret signed URL'));
  await expect(getYoutubePost(`https://youtube.com/post/${id}`)).rejects.toMatchObject({ statusCode: 502, message: 'Gagal mengambil post YouTube. Coba lagi sebentar.' });
});
