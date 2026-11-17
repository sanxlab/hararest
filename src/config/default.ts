import dotenv from 'dotenv';
import { z } from 'zod';
import { privateCookiePath, restoreCookieFile } from './cookies';

dotenv.config({ quiet: true });

const ConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(1337),
  trustProxyHops: z.coerce.number().int().min(0).max(5).default(0),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  playerPublicUrl: z
    .string()
    .default('')
    .refine((value) => {
      if (!value) return true;
      try {
        const url = new URL(value);
        return (
          ['https:', 'http:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash &&
          url.pathname === '/'
        );
      } catch {
        return false;
      }
    }, 'PLAYER_PUBLIC_URL must be an HTTP(S) origin without credentials, path, query, or fragment.'),
  rpgUpstreamUrl: z.string().default('').refine(value => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
    } catch { return false; }
  }, 'RPG_UPSTREAM_URL must be an HTTP(S) origin without credentials or path.'),
  rpgGatewaySecret: z.string().default('').refine(value => !value || (value.length >= 32 && !/\s/.test(value)), 'RPG_GATEWAY_SECRET needs at least 32 characters without whitespace.'),
  youtube: z.object({
    concurrency: z.coerce.number().int().min(1).max(8).default(4),
    // Consecutive stalled downloads before the process restarts itself; 0 disables.
    stallRestartAfter: z.coerce.number().int().min(0).max(20).default(3),
    binPath: z.string().default('./bin/yt-dlp'),
    cookiePath: z.string().default('./cookies.txt'),
    tmpDir: z.string().default('./tmp'),
    potProviderUrl: z
      .string()
      .default('')
      .refine((value) => {
        if (!value) return true;
        try {
          const url = new URL(value);
          return (
            ['http:', 'https:'].includes(url.protocol) &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash &&
            !/[;,\s]/.test(value)
          );
        } catch {
          return false;
        }
      }, 'YTDLP_POT_PROVIDER_URL must be an HTTP(S) URL without credentials, query, or fragment.'),
  }),
});

export const config = ConfigSchema.parse({
  port: process.env.PORT,
  trustProxyHops: process.env.TRUST_PROXY_HOPS,
  nodeEnv: process.env.NODE_ENV,
  playerPublicUrl: process.env.PLAYER_PUBLIC_URL?.trim(),
  rpgUpstreamUrl: process.env.RPG_UPSTREAM_URL?.trim(),
  rpgGatewaySecret: process.env.RPG_GATEWAY_SECRET?.trim(),
  youtube: {
    concurrency: process.env.YTDLP_CONCURRENCY,
    stallRestartAfter: process.env.YTDLP_STALL_RESTART_AFTER,
    binPath: process.env.YTDLP_PATH,
    // Priority: base64 Config Var, then a private file that the home helper
    // sync fills at runtime, then a mounted file path.
    cookiePath:
      restoreCookieFile(process.env.YTDLP_COOKIES_BASE64) ??
      (process.env.HOME_HELPER_URL?.trim() ? privateCookiePath() : process.env.YTDLP_COOKIES_PATH),
    tmpDir: process.env.TMP_DIR,
    potProviderUrl: process.env.YTDLP_POT_PROVIDER_URL,
  },
});
