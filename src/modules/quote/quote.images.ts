import axios from 'axios';
import sharp from 'sharp';
import { assertPublicUrl } from '../../middlewares/ssrf.middleware';
import { publicHttpAgent, publicHttpsAgent } from '../../utils/publicAgent';
import { AppError } from '../../utils/AppError';

// Decode only bounded raster images before handing them to the offline renderer.
export async function loadQuoteImage(input: string, signal: AbortSignal): Promise<string> {
  let target = input;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicUrl(target);
    const response = await axios.get<ArrayBuffer>(target, {
      responseType: 'arraybuffer',
      timeout: 8000,
      signal,
      maxRedirects: 0,
      maxContentLength: 5 * 1024 * 1024,
      proxy: false,
      httpAgent: publicHttpAgent,
      httpsAgent: publicHttpsAgent,
      headers: {
        'User-Agent': 'Hararest/1.0',
        Accept: 'image/png,image/jpeg,image/webp,image/gif',
      },
      validateStatus: (status) =>
        (status >= 200 && status < 300) || [301, 302, 303, 307, 308].includes(status),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (typeof response.headers.location !== 'string')
        throw new AppError('Invalid quote image redirect.', 502);
      target = new URL(response.headers.location, target).href;
      continue;
    }
    const data = Buffer.from(response.data);
    const options = { limitInputPixels: 16_000_000, animated: false };
    const meta = await sharp(data, options).metadata();
    if (!meta.format || !['jpeg', 'png', 'webp', 'gif'].includes(meta.format)) {
      throw new AppError('Quote images must be PNG, JPEG, WebP, or GIF.', 400);
    }
    const png = await sharp(data, options)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  }
  throw new AppError('Too many quote image redirects.', 502);
}
