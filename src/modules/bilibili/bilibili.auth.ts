import { BilibiliOpusResult } from './bilibili.types';

function encodeSessdata(value: string): string {
  // Browser cookies may already contain escapes such as %2C. Normalize once
  // before encoding so those escapes do not become %252C and invalidate login.
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Raw cookie values can contain a literal percent sign.
  }
  return encodeURIComponent(decoded);
}

export function bilibiliRequestHeaders(headers: BilibiliOpusResult['headers']) {
  const sessdata = process.env.BILIBILI_SESSDATA?.trim();
  return {
    ...headers,
    ...(sessdata ? { Cookie: `SESSDATA=${encodeSessdata(sessdata)}` } : {}),
  };
}
