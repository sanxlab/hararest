import rateLimit from 'express-rate-limit';

/**
 * General API rate limiter.
 * Allows 60 requests per minute per IP for lightweight endpoints
 * (metadata lookups, health checks, etc.).
 */
export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'fail',
    message: 'Too many requests, please try again later.',
  },
});

/**
 * Strict rate limiter for heavy download/scraping operations.
 * Allows 10 requests per minute per IP to protect against abuse,
 * prevent IP bans from upstream platforms, and limit resource usage.
 */
export const downloadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    status: 'fail',
    message: 'Download rate limit exceeded. Please wait before trying again.',
  },
});
