import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: process.env.PORT || 1337,
  nodeEnv: process.env.NODE_ENV || 'development',
  youtube: {
    binPath: process.env.YTDLP_PATH || './bin/yt-dlp',
    cookiePath: process.env.YTDLP_COOKIES_PATH || './cookies.txt',
    tmpDir: process.env.TMP_DIR || './tmp',
  },
};
