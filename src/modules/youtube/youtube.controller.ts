import { NextFunction, Request, Response } from 'express';
import { YoutubeService } from './youtube.service';
import { AppError } from '../../utils/AppError';
import logger from '../../utils/logger';
import fs from 'fs';

const youtubeService = new YoutubeService();

const cleanupFile = (filePath: string) => {
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') {
      logger.warn('Failed to clean up downloaded file', { filePath, error: err.message });
    }
  });
};

const handleDownloadError = (err: Error, filePath: string, res: Response, next: NextFunction) => {
  logger.error('Error sending downloaded file', {
    filePath,
    headersSent: res.headersSent,
    error: err.message,
    stack: err.stack,
  });

  cleanupFile(filePath);

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
    const { url } = req.query;

    if (!url || typeof url !== 'string') {
      return next(new AppError('URL is required', 400));
    }

    const filePath = await youtubeService.downloadVideo(url);

    res.download(filePath, (err) => {
      if (err) {
        handleDownloadError(err, filePath, res, next);
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

    const filePath = await youtubeService.downloadAudio(url);

    res.download(filePath, (err) => {
      if (err) {
        handleDownloadError(err, filePath, res, next);
        return;
      }

      cleanupFile(filePath);
    });
  } catch (error) {
    next(error);
  }
};
