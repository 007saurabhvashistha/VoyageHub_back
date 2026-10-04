import rateLimit from 'express-rate-limit';

export function createRateLimiter({ windowMs, limit }, message, options = {}) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message } },
    ...options,
  });
}
