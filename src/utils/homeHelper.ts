import axios from 'axios';

// One private home-server origin serves every helper feature (lyrics, cookies).
// The transport is deliberately restricted to a tailnet IPv4 address so the
// bearer token is never sent anywhere else.
const TAILNET_IPV4 = /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/;
export const HOME_HELPER_PORT = '20129';

export function homeHelperConfigured(): boolean {
  return !!process.env.HOME_HELPER_URL?.trim();
}

function endpoint(pathname: string): { url: string; token: string } {
  const url = new URL(process.env.HOME_HELPER_URL?.trim() ?? '');
  if (url.protocol !== 'http:' || !TAILNET_IPV4.test(url.hostname) || url.port !== HOME_HELPER_PORT ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Invalid home helper endpoint');
  }
  const token = process.env.HOME_HELPER_TOKEN?.trim();
  if (!token || token.length < 32) throw new Error('Missing home helper token');
  url.pathname = pathname;
  return { url: url.toString(), token };
}

interface HelperOptions {
  signal?: AbortSignal;
  timeout: number;
  maxBytes: number;
}

// Returns any 2xx/4xx response so callers can react to 404/412; throws on
// transport failures and 5xx.
export async function homeHelperRequest(
  method: 'GET' | 'PUT',
  pathname: string,
  options: HelperOptions & { body?: Buffer; headers?: Record<string, string> },
): Promise<{ status: number; data: string; headers: Record<string, unknown> }> {
  const { url, token } = endpoint(pathname);
  const response = await axios.request<string>({
    method, url, data: options.body,
    responseType: 'text', transformResponse: [], signal: options.signal, timeout: options.timeout,
    maxRedirects: 0, maxContentLength: options.maxBytes, maxBodyLength: options.maxBytes,
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
    validateStatus: (status) => status < 500,
    // Heroku runs tailscaled in userspace mode; tailnet traffic uses its proxy.
    proxy: process.env.TAILSCALE_AUTHKEY ? { protocol: 'http', host: '127.0.0.1', port: 1056 } : false,
  });
  return { status: response.status, data: response.data, headers: response.headers as Record<string, unknown> };
}

export async function homeHelperGet(pathname: string, options: HelperOptions): Promise<string> {
  const response = await homeHelperRequest('GET', pathname, options);
  if (response.status !== 200) throw new Error(`Home helper returned ${response.status}`);
  return response.data;
}
