import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { errorHandler } from './middlewares/error.middleware';
import { ssrfProtect } from './middlewares/ssrf.middleware';
import { apiLimiter, downloadLimiter } from './middlewares/ratelimit.middleware';
import { AppError } from './utils/AppError';

const app = express();


app.use(helmet());
app.use(cors());
app.use(express.json());

// Apply general rate limit to all API routes
app.use('/api', apiLimiter);

import healthRouter from './modules/health/health.route';
import youtubeRouter from './modules/youtube/youtube.route';
import facebookRouter from './modules/facebook/facebook.route';
import instagramRouter from './modules/instagram/instagram.route';
import tiktokRouter from './modules/tiktok/tiktok.route';
import xiaohongshuRouter from './modules/xiaohongshu/xiaohongshu.route';
import twitterRouter from './modules/twitter/twitter.route';
import threadsRouter from './modules/threads/threads.route';


app.use('/health', healthRouter);
app.use('/api/youtube', downloadLimiter, ssrfProtect(['youtube.com', 'youtu.be']), youtubeRouter);
app.use('/api/facebook', downloadLimiter, ssrfProtect(['facebook.com', 'www.facebook.com', 'fb.watch', 'fb.gg']), facebookRouter);
app.use('/api/instagram', downloadLimiter, ssrfProtect(['instagram.com', 'www.instagram.com', 'instagr.am']), instagramRouter);
app.use('/api/tiktok', downloadLimiter, ssrfProtect(['tiktok.com', 'www.tiktok.com', 'vt.tiktok.com', 'vm.tiktok.com']), tiktokRouter);
app.use('/api/xiaohongshu', downloadLimiter, ssrfProtect(['xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com']), xiaohongshuRouter);
app.use('/api/twitter', downloadLimiter, ssrfProtect(['twitter.com', 'www.twitter.com', 'x.com', 'www.x.com']), twitterRouter);
app.use('/api/threads', downloadLimiter, ssrfProtect(['threads.net', 'www.threads.net']), threadsRouter);

app.get('/', (req, res) => {
  res.send(new Date().toISOString());
});


app.use((req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});


app.use(errorHandler);

export default app;
