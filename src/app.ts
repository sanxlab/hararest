import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { errorHandler } from './middlewares/error.middleware';
import { AppError } from './utils/AppError';

const app = express();


app.use(helmet());
app.use(cors());
app.use(express.json());

import healthRouter from './modules/health/health.route';
import youtubeRouter from './modules/youtube/youtube.route';
import bratRouter from './modules/brat/brat.route';
import facebookRouter from './modules/facebook/facebook.route';
import instagramRouter from './modules/instagram/instagram.route';
import tiktokRouter from './modules/tiktok/tiktok.route';
import xiaohongshuRouter from './modules/xiaohongshu/xiaohongshu.route';
import twitterRouter from './modules/twitter/twitter.route';


app.use('/health', healthRouter);
app.use('/api/youtube', youtubeRouter);
app.use('/api/brat', bratRouter);
app.use('/api/facebook', facebookRouter);
app.use('/api/instagram', instagramRouter);
app.use('/api/tiktok', tiktokRouter);
app.use('/api/xiaohongshu', xiaohongshuRouter);
app.use('/api/twitter', twitterRouter);

app.get('/', (req, res) => {
  res.send(new Date().toISOString());
});


app.use((req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});


app.use(errorHandler);

export default app;
