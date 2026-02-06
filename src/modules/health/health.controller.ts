import { Request, Response, NextFunction } from 'express';

export const getHealthHandler = (req: Request, res: Response, _next: NextFunction) => {
  res.status(200).json({
    status: 'success',
    message: 'Server is healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
};
