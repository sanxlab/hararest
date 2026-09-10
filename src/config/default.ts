import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

const ConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(1337),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  playerPublicUrl: z.string().default('').refine((value) => {
    if (!value) return true;
    try {
      const url = new URL(value);
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password &&
        !url.search && !url.hash && url.pathname === '/';
    } catch { return false; }
  }, 'PLAYER_PUBLIC_URL must be an HTTP(S) origin without credentials, path, query, or fragment.'),
  youtube: z.object({
    binPath: z.string().default('./bin/yt-dlp'),
    cookiePath: z.string().default('./cookies.txt'),
    tmpDir: z.string().default('./tmp'),
  }),
});

export const config = ConfigSchema.parse({
  port: process.env.PORT,
  nodeEnv: process.env.NODE_ENV,
  playerPublicUrl: process.env.PLAYER_PUBLIC_URL?.trim(),
  youtube: {
    binPath: process.env.YTDLP_PATH,
    cookiePath: process.env.YTDLP_COOKIES_PATH,
    tmpDir: process.env.TMP_DIR,
  },
});
