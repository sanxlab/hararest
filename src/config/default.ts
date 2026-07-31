import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const ConfigSchema = z.object({
  port: z.coerce.number().int().min(1).max(65535).default(1337),
  nodeEnv: z.enum(['development', 'production', 'test']).default('development'),
  youtube: z.object({
    binPath: z.string().default('./bin/yt-dlp'),
    cookiePath: z.string().default('./cookies.txt'),
    tmpDir: z.string().default('./tmp'),
  }),
});

export const config = ConfigSchema.parse({
  port: process.env.PORT,
  nodeEnv: process.env.NODE_ENV,
  youtube: {
    binPath: process.env.YTDLP_PATH,
    cookiePath: process.env.YTDLP_COOKIES_PATH,
    tmpDir: process.env.TMP_DIR,
  },
});
