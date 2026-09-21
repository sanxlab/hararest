import { queryInteger } from '../../utils/query';
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

const cleanupFile = (filePath: string): Promise<void> => {
  return fs.promises.unlink(filePath).catch((err: NodeJS.ErrnoException) => {
    if (err && err.code !== 'ENOENT') {
      logger.warn('Failed to clean up downloaded file', { filePath, error: err.message });
    }
  });
};

const prepareDownload = async (
  req: Request,
  res: Response,
  work: (signal: AbortSignal) => Promise<string>,
): Promise<string | undefined> => {
  const abort = new AbortController();
  const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(9 * 60_000)]);
  const onClose = () => { if (!res.writableEnded) abort.abort(); };
  res.once('close', onClose);
  try {
    const file = await work(signal);
    if (signal.aborted || res.destroyed) {
      await cleanupFile(file);
      return undefined;
    }
    return file;
  } finally {
    res.off('close', onClose);
  }
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
    return next(err);
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

    if (quality !== undefined && quality !== '' && (typeof quality !== 'string' || !/^[1-9]\d{1,3}p?$/.test(quality))) {
      return next(new AppError('Quality must be a resolution such as 360p or 720p.', 400));
    }
    const qualityStr = typeof quality === 'string' && quality ? quality : undefined;
    const filePath = await prepareDownload(req, res, signal => youtubeService.downloadVideo(url, qualityStr, { signal }));
    if (!filePath) return;

    res.download(filePath, (err) => {
      if (err) {
        handleDownloadError(err, filePath, req, res, next);
        return;
      }

      cleanupFile(filePath);
    });
  } catch (error) {
    if (!res.destroyed) next(error);
  }
};

export const downloadAudioHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      return next(new AppError('URL is required', 400));
    }

    extendDownloadTimeout(req, res);

    const filePath = await prepareDownload(req, res, signal => youtubeService.downloadAudio(url, { signal }));
    if (!filePath) return;

    res.download(filePath, (err) => {
      if (err) {
        handleDownloadError(err, filePath, req, res, next);
        return;
      }

      cleanupFile(filePath);
    });
  } catch (error) {
    if (!res.destroyed) next(error);
  }
};

export const searchHandler = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { q, limit } = req.query;

    if (!q || typeof q !== 'string') {
      return next(new AppError('Search query (q) is required', 400));
    }

    const maxResults = queryInteger(limit, 'limit', 5, 10);

    const results = await youtubeService.search(q, maxResults);

    res.status(200).json({
      status: 'success',
      data: results,
    });
  } catch (error) {
    next(error);
  }
};
