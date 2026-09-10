import { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/AppError';
import logger from '../utils/logger';

export const errorHandler = (err: AppError, req: Request, res: Response, next: NextFunction) => {
  const code = err.statusCode || (err as unknown as { status?: number }).status;
  err.statusCode = typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500;
  err.status = err.statusCode < 500 ? 'fail' : 'error';

  logger.error(err.message, { stack: err.stack, path: req.path, method: req.method });

  if (res.headersSent) {
    return next(err);
  }

  res.status(err.statusCode).json({
    status: err.status,
    message: err.message,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};
