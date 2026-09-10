import { RequestHandler } from 'express';
import { AppError } from '../utils/AppError';

// Express query values can be arrays/objects; a TypeScript cast does not validate them.
export const validateQuery: RequestHandler = (req, _res, next) => {
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value !== 'string' || !value.trim()) {
      return next(new AppError(`Parameter "${key}" must be a non-empty string.`, 400));
    }
  }
  next();
};
