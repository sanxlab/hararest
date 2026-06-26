import { NextFunction, Request, Response } from 'express';
import { YoutubeService } from './youtube.service';
import { AppError } from '../../utils/AppError';
import fs from 'fs';

const youtubeService = new YoutubeService();

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
        next(new AppError('Error downloading file', 500));
      }
      
      fs.unlink(filePath, () => {});
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
        next(new AppError('Error downloading file', 500));
      }

      fs.unlink(filePath, () => {});
    });
  } catch (error) {
    next(error);
  }
};
