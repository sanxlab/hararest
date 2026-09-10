import { publicHttpAgent, publicHttpsAgent } from './publicAgent';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { assertPublicUrl } from '../middlewares/ssrf.middleware';
import { AppError } from './AppError';

/** Short links need redirects, but every hop must stay on a permitted public host. */
export async function getPublicPage<T>(
  url: string,
  allowedHosts: readonly string[],
  options: AxiosRequestConfig = {},
): Promise<AxiosResponse<T>> {
  let target = url;
  for (let hop = 0; hop <= 5; hop++) {
    await assertPublicUrl(target, allowedHosts);
    const response = await axios.get<T>(target, {
      ...options,
      timeout: 15000,
      maxContentLength: 5 * 1024 * 1024,
      maxRedirects: 0,
      proxy: false,
      httpAgent: publicHttpAgent,
      httpsAgent: publicHttpsAgent,
      validateStatus: (status) => (status >= 200 && status < 300) || [301, 302, 303, 307, 308].includes(status),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.location;
    if (typeof location !== 'string') throw new AppError('Upstream redirect has no location.', 502);
    target = new URL(location, target).toString();
  }
  throw new AppError('Too many upstream redirects.', 502);
}
