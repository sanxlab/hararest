import { Request, Response, NextFunction } from 'express';
import logger from '../utils/logger';
import { publicErrorMessage } from '../utils/errorResponse';

export const errorHandler = (err: unknown, req: Request, res: Response, next: NextFunction) => {
  const error = err instanceof Error ? err : new Error('Unexpected application error.');
  const details = error as Error & { statusCode?: unknown; status?: unknown };
  const code = details.statusCode ?? details.status;
  const statusCode = typeof code === 'number' && Number.isInteger(code) && code >= 400 && code <= 599 ? code : 500;

  logger.error(error.message, { stack: error.stack, path: req.path, method: req.method });

  if (res.headersSent) {
    return next(err);
  }

  res.status(statusCode).json({
    status: statusCode < 500 ? 'fail' : 'error',
    message: publicErrorMessage(err, statusCode),
    ...(process.env.NODE_ENV === 'development' && { stack: error.stack }),
  });
};
