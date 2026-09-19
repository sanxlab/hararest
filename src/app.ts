import { config } from './config/default';
import express from "express";
import cors from "cors";
import helmet from "helmet";
import { errorHandler } from "./middlewares/error.middleware";
import { ssrfProtect } from "./middlewares/ssrf.middleware";
import { apiLimiter, downloadLimiter, jobStatusLimiter } from "./middlewares/ratelimit.middleware";
import { AppError } from "./utils/AppError";

import { validateQuery } from './middlewares/query.middleware';
import { jobRoutes } from './modules/jobs/jobs.route';

const app = express();
app.set('trust proxy', config.trustProxyHops);

app.use(helmet());
app.use(cors());
app.use(express.json());

app.use('/api/jobs', jobStatusLimiter, jobRoutes.statusRouter);
app.post('/api/youtube/jobs', apiLimiter, downloadLimiter, jobRoutes.createDownload);
app.post('/api/player/jobs', apiLimiter, downloadLimiter, jobRoutes.createPlayer);

app.use("/api", apiLimiter, validateQuery);

import healthRouter from "./modules/health/health.route";
import youtubeRouter from "./modules/youtube/youtube.route";
import facebookRouter from "./modules/facebook/facebook.route";
import instagramRouter from "./modules/instagram/instagram.route";
import tiktokRouter from "./modules/tiktok/tiktok.route";
import xiaohongshuRouter from "./modules/xiaohongshu/xiaohongshu.route";
import bilibiliRouter from './modules/bilibili/bilibili.route';
import { BILIBILI_HOSTS } from './modules/bilibili/bilibili.service';
import twitterRouter from "./modules/twitter/twitter.route";
import threadsRouter from "./modules/threads/threads.route";
import ocrRouter from "./modules/ocr/ocr.route";
import pinterestRouter from "./modules/pinterest/pinterest.route";
import pixivRouter from "./modules/pixiv/pixiv.route";
import braveRouter from "./modules/brave/brave.route";
import wikipediaRouter from "./modules/wikipedia/wikipedia.route";
import redditRouter from "./modules/reddit/reddit.route";
import nsfwRouter from "./modules/nsfw/nsfw.route";
import { playerApiRouter, playerPageRouter } from './modules/player/player.route';

app.use("/health", healthRouter);
app.use("/api/youtube", downloadLimiter, ssrfProtect(["youtube.com", "youtu.be"]), youtubeRouter);
app.use("/api/facebook", downloadLimiter, ssrfProtect(["facebook.com", "www.facebook.com", "fb.watch", "fb.gg"]), facebookRouter);
app.use("/api/instagram", downloadLimiter, ssrfProtect(["instagram.com", "www.instagram.com", "instagr.am"]), instagramRouter);
app.use("/api/tiktok", downloadLimiter, ssrfProtect(["tiktok.com", "www.tiktok.com", "vt.tiktok.com", "vm.tiktok.com"]), tiktokRouter);
app.use("/api/xiaohongshu", downloadLimiter, ssrfProtect(["xiaohongshu.com", "www.xiaohongshu.com", "xhslink.com"]), xiaohongshuRouter);
app.use('/api/bilibili', downloadLimiter, ssrfProtect(BILIBILI_HOSTS), bilibiliRouter);
app.use("/api/twitter", downloadLimiter, ssrfProtect(["twitter.com", "www.twitter.com", "x.com", "www.x.com"]), twitterRouter);
app.use("/api/threads", downloadLimiter, ssrfProtect(["threads.net", "threads.com"]), threadsRouter);
app.use("/api/pinterest", downloadLimiter, ssrfProtect(["pinterest.com", "www.pinterest.com", "id.pinterest.com", "pin.it"]), pinterestRouter);
app.use("/api/pixiv", downloadLimiter, ssrfProtect(["pixiv.net", "www.pixiv.net"]), pixivRouter);
app.use("/api/ocr", downloadLimiter, express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: "15mb" }), ocrRouter);
app.use("/api/brave", braveRouter);
app.use("/api/wikipedia", wikipediaRouter);
app.use("/api/reddit", downloadLimiter, redditRouter);
app.use("/api/nsfw", downloadLimiter, nsfwRouter);
app.use('/api/player', downloadLimiter, playerApiRouter);
app.use('/player', playerPageRouter);

app.get("/", (req, res) => {
  res.send(new Date().toISOString());
});

app.use((req, res, next) => {
  next(new AppError(`Can't find ${req.originalUrl} on this server!`, 404));
});

app.use(errorHandler);

export default app;
