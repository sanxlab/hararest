import { NextFunction, Request, Response } from 'express';
import { YoutubeService } from './youtube.service';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import fs from 'fs';

const youtubeService = new YoutubeService();
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

const extendDownloadTimeout = (req: Request, res: Response) => {
  req.setTimeout(DOWNLOAD_TIMEOUT_MS);
  res.setTimeout(DOWNLOAD_TIMEOUT_MS);
};

const cleanupFile = (filePath: string) => {
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      logger.warn('Failed to clean up downloaded file', { filePath, error: err.message });
    }
  });
};

const isRequestAbortedError = (err: Error, req: Request, res: Response) =>
  err.message === 'Request aborted' || req.aborted || res.destroyed;

const handleDownloadError = (
  err: Error,
  filePath: string,
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  cleanupFile(filePath);

  if (isRequestAbortedError(err, req, res)) {
    logger.warn('Download request aborted before the file was fully sent', {
      filePath,
      headersSent: res.headersSent,
      requestAborted: req.aborted,
      responseDestroyed: res.destroyed,
      error: err.message,
    });
    return;
  }

  logger.error('Error sending downloaded file', {
    filePath,
    headersSent: res.headersSent,
    error: err.message,
    stack: err.stack,
  });

  if (res.headersSent) {
    return;
  }

  next(new AppError('Error downloading file', 500));
};

export const getInfoHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      return next(new AppError('URL is required', 400));
    }

    const info = await youtubeService.getInfo(url);

    res.status(200).json({
      status: 'success',
      data: info,
    });
  } catch (error) {
    next(error);
  }
};

export const downloadVideoHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url, quality } = req.query;

    if (!url || typeof url !== 'string') {
      return next(new AppError('URL is required', 400));
    }

    extendDownloadTimeout(req, res);

    const qualityStr = typeof quality === 'string' ? quality : undefined;
    const filePath = await youtubeService.downloadVideo(url, qualityStr);

    res.download(filePath, (err) => {
      if (err) {
        handleDownloadError(err, filePath, req, res, next);
        return;
      }

      cleanupFile(filePath);
    });
  } catch (error) {
    next(error);
  }
};

export const downloadAudioHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      return next(new AppError('URL is required', 400));
    }

    extendDownloadTimeout(req, res);

    const filePath = await youtubeService.downloadAudio(url);

    res.download(filePath, (err) => {
      if (err) {
        handleDownloadError(err, filePath, req, res, next);
        return;
      }

      cleanupFile(filePath);
    });
  } catch (error) {
    next(error);
  }
};

export const searchHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, limit } = req.query;

    if (!q || typeof q !== 'string') {
      return next(new AppError('Search query (q) is required', 400));
    }

    const maxResults = limit ? Math.min(Math.max(1, Number(limit)), 10) : 5;

    const results = await youtubeService.search(q, maxResults);

    res.status(200).json({
      status: 'success',
      data: results,
    });
  } catch (error) {
    next(error);
  }
};
